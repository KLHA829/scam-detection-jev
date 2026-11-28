'use strict';

const { isDirectArchiveHit, officialHosts } = require('./link-rules');

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_UNSUPPORTED_RESPONSE_FORMAT_ENTRIES = 256;
const DEFAULT_UNSUPPORTED_RESPONSE_FORMAT_TTL_MS = 30 * 60 * 1000;

const unsupportedResponseFormatByFetch = new WeakMap();

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

/**
 * The system prompt plus which domains in the masked text are brands' own, checked against the
 * allowlist here so a sender cannot claim it in the message. Unchanged when there are none.
 */
function withOfficialHosts(systemPrompt, maskedText) {
  const hosts = [...new Set(officialHosts(maskedText).map(({ host }) => host))];
  if (!hosts.length) return systemPrompt;
  return [
    systemPrompt,
    `Checked on this device: ${hosts.join(', ')} ${hosts.length === 1 ? 'is the official domain' : 'are official domains'} of a known bank, payment service, courier or WhatsApp, not a lookalike.`,
    'A link on an official domain is not a deceptive or fake page; still judge whether the request itself is a scam.',
  ].join(' ');
}

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

function positiveEnvNumber(env, name, fallback) {
  const n = envNumber(env, name, fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function llmReviewEnabled(env = process.env) {
  return envFlag(env, 'LLM_REVIEW_ENABLED', true);
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
    timeoutMs: positiveEnvNumber(env, 'LLM_REVIEW_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
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

function scanJsonObjects(candidate) {
  let found = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(candidate.slice(start, i + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            found = parsed;
          }
        } catch {}
        start = -1;
      }
    }
  }
  return found;
}

function extractJsonObject(text) {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .trim();
  if (!cleaned) return null;
  const fences = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidate = fences.length ? fences[fences.length - 1][1].trim() : cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {}
    }
    return scanJsonObjects(candidate) || scanJsonObjects(cleaned);
  }
}

function parseLlmReview(payload) {
  const parsed = extractJsonObject(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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

function unsupportedResponseFormatKey(url, model) {
  return `${url}\0${model || ''}`;
}

function hasUnsupportedResponseFormat(fetchImpl, key, nowMs) {
  if (typeof fetchImpl !== 'function') return false;
  const unsupported = unsupportedResponseFormatByFetch.get(fetchImpl);
  if (!unsupported) return false;
  const expiresAt = unsupported.get(key);
  if (expiresAt == null) return false;
  if (nowMs >= expiresAt) {
    unsupported.delete(key);
    return false;
  }
  return true;
}

function rememberUnsupportedResponseFormat(fetchImpl, key, nowMs, ttlMs) {
  if (typeof fetchImpl !== 'function' || ttlMs <= 0) return;
  let unsupported = unsupportedResponseFormatByFetch.get(fetchImpl);
  if (!unsupported) {
    unsupported = new Map();
    unsupportedResponseFormatByFetch.set(fetchImpl, unsupported);
  }
  unsupported.delete(key);
  if (unsupported.size >= MAX_UNSUPPORTED_RESPONSE_FORMAT_ENTRIES) {
    for (const [entryKey, expiresAt] of unsupported.entries()) {
      if (nowMs >= expiresAt) unsupported.delete(entryKey);
    }
  }
  if (unsupported.size >= MAX_UNSUPPORTED_RESPONSE_FORMAT_ENTRIES) {
    unsupported.delete(unsupported.keys().next().value);
  }
  unsupported.set(key, nowMs + ttlMs);
}

function hasJsonObjectCompletion(res) {
  if (!res || !res.ok) return false;
  const parsed = extractJsonObject(contentFromChatCompletion(res.json));
  return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
}

async function postChatJson(url, baseBody, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const nowMs = opts && typeof opts.now === 'function' ? opts.now() : Date.now();
  const ttlMs =
    opts && Number.isFinite(opts.unsupportedResponseFormatTtlMs)
      ? opts.unsupportedResponseFormatTtlMs
      : DEFAULT_UNSUPPORTED_RESPONSE_FORMAT_TTL_MS;
  const key = unsupportedResponseFormatKey(url, baseBody && baseBody.model);
  if (hasUnsupportedResponseFormat(fetchImpl, key, nowMs)) {
    return postChatCompletions(url, baseBody, opts);
  }
  let res = await postChatCompletions(
    url,
    { ...baseBody, response_format: { type: 'json_object' } },
    opts,
  );
  if (res.status !== 400) return res;
  res = await postChatCompletions(url, baseBody, opts);
  if (hasJsonObjectCompletion(res)) {
    rememberUnsupportedResponseFormat(fetchImpl, key, nowMs, ttlMs);
  }
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

  const systemBase = withOfficialHosts(SYSTEM_PROMPT, redactedText);
  const system = cfg.feedHit === true
    ? `${systemBase} Checked on this device: a link in this message leads to a host on the PhishTank verified phishing feed. Treat that link as strong scam evidence; still judge whether the message is a warning about it rather than the scam itself.`
    : systemBase;
  const messages = [
    { role: 'system', content: system },
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

function hardSkipReason({ decision, heuristic } = {}) {
  const reason =
    decision && decision.action === 'archive' ? decision.archiveReason : null;
  if (reason && HARD_SKIP_ARCHIVE_REASONS.has(reason)) return 'hard_archive';
  if (isDirectArchiveHit(heuristic)) return 'hard_archive';
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
 * Merge the LLM label into the primary decision:
 * - scam meeting min confidence → archive `llm_review_scam`
 * - not_scam / unknown / fail → keep the primary decision (fail-closed)
 */
function mergeLlmDecision(decision, llmReview, options = {}) {
  if (!decision || !llmReview) return decision;
  const env = options.env || process.env;
  if (
    llmReview.ok &&
    llmReview.label === 'scam' &&
    llmMeetsMinConfidence(llmReview, env)
  ) {
    return { action: 'archive', archiveReason: 'llm_review_scam' };
  }
  return decision;
}

module.exports = {
  DEFAULT_MIN_CONFIDENCE,
  llmReviewMinConfidence,
  llmMeetsMinConfidence,
  HARD_SKIP_ARCHIVE_REASONS,
  SYSTEM_PROMPT,
  llmReviewEnabled,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
  contentFromChatCompletion,
  extractJsonObject,
  postChatCompletions,
  postChatJson,
  isValidConfidence,
  parseLlmReview,
  reviewRedactedMessage,
  withOfficialHosts,
  shouldTriggerLlmReview,
  mergeLlmDecision,
};
