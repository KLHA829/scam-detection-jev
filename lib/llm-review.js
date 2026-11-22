'use strict';

const { isMaliciousUrlHit } = require('./link-rules');

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 8000;

const DEFAULT_MERGE = 'bonsai';

/** Primary-model archives that the second-pass LLM may release on `not_scam`. */
const SCORE_ARCHIVE_REASONS = new Set(['jevlike_score']);

/** Absolute archives: never send to the LLM and never release. */
const HARD_SKIP_ARCHIVE_REASONS = new Set(['obvious_scam']);

const SYSTEM_PROMPT = [
  'You review a single WhatsApp DM for scam risk.',
  'The text is already PII-redacted. Do not reconstruct names, phones, accounts, IDs, or emails.',
  'Reply with ONE JSON object and no extra keys:',
  '{"label":"scam"|"not_scam"|"unknown","confidence":0-1,"signals":["string"],"should_archive":true|false,"reason":"short string"}',
  'Use label scam and should_archive true only for scam solicitation: OTP/password harvest, money/FPS/PayMe transfer, impersonation plus secrecy, or a lure to log in or share information via a deceptive link.',
  'Anti-scam news or warnings that quote a suspicious link or tell the user NOT to send OTP/money are not_scam and should_archive false.',
  'If unsure, label unknown and should_archive false.',
].join(' ');

function envFlag(env, name, defaultValue = false) {
  const v = env[name];
  if (v == null || v === '') return defaultValue;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function llmReviewAll(env = process.env) {
  return envFlag(env, 'LLM_REVIEW_ALL', false);
}

function llmReviewEnabled(env = process.env) {
  return envFlag(env, 'LLM_REVIEW_ENABLED', true);
}

/**
 * Merge policy when the LLM disagrees with the primary scorer.
 * - bonsai (default): FP-aware Bonsai merge — LLM scam archives; LLM not_scam
 *   releases score-only archives; unknown/fail keeps the primary decision.
 * - archive_only: LLM may archive extra DMs but never release a score archive.
 */
function llmReviewMergePolicy(env = process.env) {
  const raw = String(env.LLM_REVIEW_MERGE || DEFAULT_MERGE)
    .trim()
    .toLowerCase();
  if (raw === 'archive_only' || raw === 'archive-only' || raw === 'no_release') {
    return 'archive_only';
  }
  return 'bonsai';
}

function llmReviewMinConfidence(env = process.env) {
  return envNumber(env, 'LLM_REVIEW_MIN_CONFIDENCE', DEFAULT_MIN_CONFIDENCE);
}

function llmMeetsMinConfidence(llmReview, env = process.env) {
  if (!llmReview || llmReview.ok !== true) return false;
  const min = llmReviewMinConfidence(env);
  const conf = llmReview.confidence;
  return isValidConfidence(conf) && conf >= min;
}

function resolveChatCompletionsUrl(apiUrl) {
  if (!apiUrl) return '';
  const trimmed = String(apiUrl).trim().replace(/\/$/, '');
  if (!trimmed) return '';
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function createLlmReviewConfig(env = process.env) {
  const apiUrl =
    env.LLM_REVIEW_API_URL ||
    env.OPENAI_BASE_URL ||
    env.OPENAI_API_BASE ||
    '';
  const apiKey = env.LLM_REVIEW_API_KEY || env.OPENAI_API_KEY || '';
  return {
    enabled: llmReviewEnabled(env),
    apiUrl,
    apiKey,
    model: env.LLM_REVIEW_MODEL || DEFAULT_MODEL,
    timeoutMs: envNumber(env, 'LLM_REVIEW_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    reviewAll: llmReviewAll(env),
    merge: llmReviewMergePolicy(env),
    minConfidence: llmReviewMinConfidence(env),
  };
}

function unknownReview(reason, extra = {}) {
  return {
    ok: false,
    label: 'unknown',
    confidence: 0,
    signals: [],
    should_archive: false,
    reason,
    ...extra,
  };
}

function isValidConfidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function parseLlmReview(payload) {
  const parsed = extractJsonObject(payload);
  if (!parsed || typeof parsed !== 'object') {
    return unknownReview('invalid_llm_json');
  }
  if (parsed.confidence != null && !isValidConfidence(parsed.confidence)) {
    return unknownReview('invalid_llm_json');
  }
  const allowed = new Set(['scam', 'not_scam', 'unknown']);
  const label = allowed.has(parsed.label) ? parsed.label : 'unknown';
  const signals = Array.isArray(parsed.signals)
    ? parsed.signals.map((s) => String(s)).filter(Boolean).slice(0, 12)
    : [];
  const shouldArchive = label === 'scam';
  return {
    ok: true,
    label,
    confidence: parsed.confidence ?? null,
    signals,
    should_archive: Boolean(shouldArchive),
    reason: parsed.reason != null ? String(parsed.reason).slice(0, 500) : '',
  };
}

function contentFromChatCompletion(json) {
  if (!json || typeof json !== 'object') return '';
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return message.content;
  if (typeof json.content === 'string') return json.content;
  return '';
}

async function postChatJson(url, baseBody, opts) {
  let res = await postChatCompletions(
    url,
    { ...baseBody, response_format: { type: 'json_object' } },
    opts,
  );
  if (res.status === 400) res = await postChatCompletions(url, baseBody, opts);
  return res;
}

async function postChatCompletions(url, body, { apiKey, timeoutMs, fetchImpl }) {
  const headers = { 'content-type': 'application/json' };
  // Local servers (llama.cpp / Ollama) often have no auth; only send Bearer when set.
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, json, bodyText: text };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('LLM review timeout', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAI-compatible chat completions. Fail-open: errors become unknown
 * and must not archive by themselves.
 */
async function reviewRedactedMessage(redactedText, options = {}) {
  const env = options.env || process.env;
  const cfg = { ...createLlmReviewConfig(env), ...options };
  if (!cfg.enabled && options.enabled == null) {
    return unknownReview('disabled');
  }
  if (cfg.enabled === false) return unknownReview('disabled');
  const url = resolveChatCompletionsUrl(cfg.apiUrl);
  if (!url) return unknownReview('missing_api_url');
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return unknownReview('fetch_unavailable');
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: String(redactedText == null ? '' : redactedText) },
  ];
  const baseBody = {
    model: cfg.model || DEFAULT_MODEL,
    temperature: 0,
    messages,
  };

  try {
    const res = await postChatJson(url, baseBody, {
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs || DEFAULT_TIMEOUT_MS,
      fetchImpl,
    });
    if (!res.ok) {
      return unknownReview('llm_http_error', { status: res.status });
    }
    const content = contentFromChatCompletion(res.json);
    const parsed = parseLlmReview(content);
    if (!parsed.ok) return parsed;
    return parsed;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const reason = /timeout/i.test(message) ? 'llm_timeout' : 'llm_error';
    return unknownReview(reason, { error: message });
  }
}

function isScoreOnlyArchive(decision) {
  return Boolean(
    decision &&
      decision.action === 'archive' &&
      SCORE_ARCHIVE_REASONS.has(decision.archiveReason),
  );
}

function hardSkipReason({ decision, heuristic } = {}) {
  const reason =
    decision && decision.action === 'archive' ? decision.archiveReason : null;
  if (reason && HARD_SKIP_ARCHIVE_REASONS.has(reason)) return 'hard_archive';
  if (isMaliciousUrlHit(heuristic)) return 'hard_archive';
  return null;
}

/**
 * Primary inbound path: mask then LLM for every message that is not a link
 * heuristic hard archive.
 */
function shouldTriggerLlmReview({
  heuristic,
  decision,
  env = process.env,
  enabled,
} = {}) {
  const on = enabled == null ? llmReviewEnabled(env) : Boolean(enabled);
  if (!on) return { trigger: false, reasons: [], skipped: 'disabled' };

  const skip = hardSkipReason({
    decision,
    heuristic,
  });
  if (skip) {
    return { trigger: false, reasons: [], skipped: skip };
  }

  return { trigger: true, reasons: ['primary_review'], skipped: null };
}

/**
 * Merge the LLM label into the primary decision.
 *
 * Default policy `bonsai` (FP-aware, same as the prior high-score Bonsai pass):
 * - scam → archive `llm_review_scam` (LLM can raise a miss)
 * - not_scam on a score-only archive → release to ignore (LLM can drop FPs)
 * - unknown / fail → keep the primary decision (score archives stay
 *   archived; grey-band non-archives stay ignore / fail-open)
 *
 * `archive_only` skips the release branch (safer against FN if the LLM is weak
 * on friend/family repayment; worse FPR on jevlike false alarms).
 */
function mergeLlmDecision(decision, llmReview, options = {}) {
  if (!decision || !llmReview) return decision;
  const env = options.env || process.env;
  const policy =
    options.merge ||
    (options.cfg && options.cfg.merge) ||
    llmReviewMergePolicy(env);
  if (
    llmReview.ok &&
    llmReview.label === 'scam' &&
    llmMeetsMinConfidence(llmReview, env)
  ) {
    return { action: 'archive', archiveReason: 'llm_review_scam' };
  }
  const mayRelease = policy !== 'archive_only';
  if (
    mayRelease &&
    llmReview.ok &&
    llmReview.label === 'not_scam' &&
    isScoreOnlyArchive(decision)
  ) {
    return {
      action: 'ignore',
      archiveReason: null,
      released: true,
      releaseReason: 'llm_review_not_scam',
    };
  }
  return decision;
}

module.exports = {
  DEFAULT_MIN_CONFIDENCE,
  llmReviewMinConfidence,
  llmMeetsMinConfidence,
  SCORE_ARCHIVE_REASONS,
  HARD_SKIP_ARCHIVE_REASONS,
  SYSTEM_PROMPT,
  llmReviewEnabled,
  llmReviewAll,
  llmReviewMergePolicy,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
  contentFromChatCompletion,
  extractJsonObject,
  postChatCompletions,
  postChatJson,
  isValidConfidence,
  parseLlmReview,
  reviewRedactedMessage,
  isScoreOnlyArchive,
  shouldTriggerLlmReview,
  mergeLlmDecision,
};
