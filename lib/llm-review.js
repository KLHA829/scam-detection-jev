'use strict';

const { isNonLocalDial } = require('./foreign-number');
const {
  analyzeScamIntent,
  isShortOtpish,
} = require('./scam-intent');

const DEFAULT_GREY_MIN = 0.4;
const DEFAULT_GREY_MAX = 0.85;
const DEFAULT_OTP_MAX_CHARS = 96;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = [
  'You review a single WhatsApp DM for scam risk.',
  'The text is already PII-redacted. Do not reconstruct names, phones, accounts, IDs, or emails.',
  'Reply with ONE JSON object and no extra keys:',
  '{"label":"scam"|"not_scam"|"unknown","confidence":0-1,"signals":["string"],"should_archive":true|false,"reason":"short string"}',
  'Use label scam and should_archive true only for solicitation: OTP/password harvest, money/FPS/PayMe transfer, or impersonation plus secrecy.',
  'Anti-scam news or warnings that tell the user NOT to send OTP/money are not_scam and should_archive false.',
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

function llmReviewEnabled(env = process.env) {
  return envFlag(env, 'LLM_REVIEW_ENABLED', false);
}

function greyBand(env = process.env) {
  return {
    min: envNumber(env, 'LLM_REVIEW_GREY_MIN', DEFAULT_GREY_MIN),
    max: envNumber(env, 'LLM_REVIEW_GREY_MAX', DEFAULT_GREY_MAX),
  };
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
    greyMin: envNumber(env, 'LLM_REVIEW_GREY_MIN', DEFAULT_GREY_MIN),
    greyMax: envNumber(env, 'LLM_REVIEW_GREY_MAX', DEFAULT_GREY_MAX),
    otpMaxChars: envNumber(
      env,
      'LLM_REVIEW_OTP_MAX_CHARS',
      DEFAULT_OTP_MAX_CHARS,
    ),
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

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
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
  const allowed = new Set(['scam', 'not_scam', 'unknown']);
  const label = allowed.has(parsed.label) ? parsed.label : 'unknown';
  const signals = Array.isArray(parsed.signals)
    ? parsed.signals.map((s) => String(s)).filter(Boolean).slice(0, 12)
    : [];
  const shouldArchive = label === 'scam' || parsed.should_archive === true;
  return {
    ok: true,
    label,
    confidence: clamp01(parsed.confidence),
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

async function postChatCompletions(url, body, { apiKey, timeoutMs, fetchImpl }) {
  const headers = { 'content-type': 'application/json' };
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
      throw new Error('LLM review timeout');
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
    let res = await postChatCompletions(
      url,
      { ...baseBody, response_format: { type: 'json_object' } },
      {
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs || DEFAULT_TIMEOUT_MS,
        fetchImpl,
      },
    );
    if (res.status === 400) {
      res = await postChatCompletions(url, baseBody, {
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs || DEFAULT_TIMEOUT_MS,
        fetchImpl,
      });
    }
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

function normalizedScore(scoreResult) {
  const score =
    scoreResult && typeof scoreResult.score === 'number' ? scoreResult.score : 0;
  return score / 100;
}

function hasHardArchive(decision) {
  return Boolean(decision && decision.action === 'archive');
}

function hasModelLocalConflict({
  scoreResult,
  heuristic,
  rag,
  localClassifier,
  intent,
}) {
  const label = (scoreResult && scoreResult.label) || 'unknown';
  const localHit = Boolean(
    (heuristic && heuristic.hit) ||
      (rag && rag.hit) ||
      (localClassifier && localClassifier.hit),
  );
  const modelScam = label === 'scam';
  if (localHit !== modelScam && (localHit || modelScam)) return true;
  const solicit =
    Boolean(intent && intent.otpForwardAsk) ||
    Boolean(intent && intent.moneyTransferAsk) ||
    Boolean(intent && intent.impersonation && intent.secrecy);
  if ((label === 'not_scam' || label === 'unknown') && solicit) return true;
  return false;
}

function isUnknownNumberContext({ savedContact, formattedNumber, intent }) {
  if (intent && intent.newNumberLanguage) return true;
  if (savedContact) return false;
  if (formattedNumber && isNonLocalDial(formattedNumber)) return true;
  return !savedContact;
}

/**
 * Narrow LLM triggers. Hard archive (LightJev / heuristic / RAG / foreign)
 * skips the LLM entirely.
 */
function shouldTriggerLlmReview({
  scoreResult,
  heuristic,
  rag,
  localClassifier,
  text,
  formattedNumber,
  savedContact,
  decision,
  env = process.env,
  enabled,
  intent,
} = {}) {
  const on = enabled == null ? llmReviewEnabled(env) : Boolean(enabled);
  if (!on) return { trigger: false, reasons: [], skipped: 'disabled' };
  if (hasHardArchive(decision)) {
    return { trigger: false, reasons: [], skipped: 'hard_archive' };
  }

  const bodyIntent = intent || analyzeScamIntent(text);
  const reasons = [];
  const band = greyBand(env);
  const norm = normalizedScore(scoreResult);
  if (norm >= band.min && norm <= band.max) reasons.push('grey_band');

  if (
    hasModelLocalConflict({
      scoreResult,
      heuristic,
      rag,
      localClassifier,
      intent: bodyIntent,
    })
  ) {
    reasons.push('conflict');
  }

  const otpMax = envNumber(env, 'LLM_REVIEW_OTP_MAX_CHARS', DEFAULT_OTP_MAX_CHARS);
  if (isShortOtpish(text, otpMax)) reasons.push('short_otp');

  if (
    bodyIntent.moneyTransferAsk &&
    isUnknownNumberContext({ savedContact, formattedNumber, intent: bodyIntent })
  ) {
    reasons.push('money_unknown_number');
  }

  return {
    trigger: reasons.length > 0,
    reasons,
    skipped: reasons.length ? null : 'no_trigger',
  };
}

function mergeLlmDecision(decision, llmReview) {
  if (!llmReview || !llmReview.ok) return decision;
  if (llmReview.should_archive || llmReview.label === 'scam') {
    return { action: 'archive', archiveReason: 'llm_review_scam' };
  }
  return decision;
}

module.exports = {
  DEFAULT_GREY_MIN,
  DEFAULT_GREY_MAX,
  DEFAULT_OTP_MAX_CHARS,
  SYSTEM_PROMPT,
  llmReviewEnabled,
  greyBand,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
  parseLlmReview,
  reviewRedactedMessage,
  shouldTriggerLlmReview,
  mergeLlmDecision,
};
