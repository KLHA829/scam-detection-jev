'use strict';

const { applyXxx } = require('./pii-xxx');
const {
  isValidConfidence,
  contentFromChatCompletion,
  extractJsonObject,
  postChatJson,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
  llmReviewMinConfidence,
} = require('./llm-review');
const { SUSPICIOUS_PITCH_CONTACT_NAME } = require('./block-policy');

const DEFAULT_CONTEXT_LLM_MESSAGES = 10;
const DEFAULT_MAX_CHATS = 1000;
const MAX_CONTEXT_LLM_MESSAGES = 10;

const CONTEXT_SYSTEM_PROMPT = [
  'You review the latest inbound WhatsApp messages of one chat, at most 10. The last line is the message that just arrived.',
  'Personal data has already been replaced with XXX. Do not try to reconstruct names, phones, accounts, IDs, or codes.',
  'Reply with ONE JSON object and no extra keys:',
  '{"action":"archive"|"block"|"no_action","pitch":true|false,"confidence":0-1,"reason":"short string"}',
  'block only for scam solicitation: OTP or password harvest, a money or FPS or PayMe transfer, impersonation plus secrecy, or a lure to log in or share information via a deceptive link.',
  'archive when you judge the chat to be a scam but there is no clear solicitation.',
  'no_action for ordinary chat (including a message saying money was already sent to the user, a bank alert that only reports a transaction or login on the user\'s own account, and a one-time code the user is told not to share), and for warnings that quote a suspicious link or tell the user NOT to send a code or money.',
  'If unsure, action no_action.',
  'Set pitch true when the chat is an unsolicited investment, trading or health-product pitch, whatever the action; otherwise false.',
].join(' ');

function envFlag(env, name, defaultValue = false) {
  const v = env[name];
  if (v == null || v === '') return defaultValue;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function contextLlmEnabled(env = process.env) {
  return envFlag(env, 'CONTEXT_LLM_ENABLED', true);
}

function contextLlmMessageLimit(env = process.env) {
  const raw = env && env.CONTEXT_LLM_MESSAGES;
  if (raw == null || raw === '') return DEFAULT_CONTEXT_LLM_MESSAGES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONTEXT_LLM_MESSAGES;
  return Math.min(MAX_CONTEXT_LLM_MESSAGES, Math.floor(n));
}

/**
 * Latest inbound bodies of a chat, oldest first, capped at 10.
 * The current message is pushed before the review, so it is always last.
 * Older messages fall off the front once the cap is full.
 * Replace by message ID, or by previous body for callers without IDs.
 */
function createRecentContext({ limit = DEFAULT_CONTEXT_LLM_MESSAGES, maxChats = DEFAULT_MAX_CHATS } = {}) {
  const chatCap = Number.isFinite(maxChats) ? Math.max(1, Math.floor(maxChats)) : DEFAULT_MAX_CHATS;
  const cap = Math.min(
    MAX_CONTEXT_LLM_MESSAGES,
    Math.max(1, Math.floor(Number(limit) || DEFAULT_CONTEXT_LLM_MESSAGES)),
  );
  const chats = new Map();
  return {
    limit: cap,
    push(chatId, text, { messageId, replaces } = {}) {
      if (!chatId) return;
      const body = String(text || '').trim();
      const list = chats.get(chatId) || [];
      const old = String(replaces || '').trim();
      const at = list.findLastIndex((entry) =>
        messageId ? entry.messageId === messageId : old && entry.body === old);
      if (at !== -1) list.splice(at, 1);
      if (body) list.push({ messageId, body });
      while (list.length > cap) list.shift();
      chats.delete(chatId);
      chats.set(chatId, list);
      if (chats.size > chatCap) chats.delete(chats.keys().next().value);
    },
    recent(chatId) {
      if (!chatId) return [];
      return (chats.get(chatId) || []).map(({ body }) => body);
    },
  };
}

function maskOneForLlm(text, spans) {
  return applyXxx(text, spans);
}

function maskMessagesForLlm(messages, maskResult) {
  const rows = maskResult && Array.isArray(maskResult.messages) ? maskResult.messages : null;
  if (!rows || rows.length !== messages.length) {
    throw new Error('incomplete mask');
  }
  return messages.map((text, index) => {
    const row = rows[index];
    const src = text == null ? '' : String(text);
    if (!row || !Array.isArray(row.spans)) throw new Error('incomplete mask');
    for (const span of row.spans) {
      if (
        !span ||
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > src.length
      ) {
        throw new Error('incomplete mask');
      }
    }
    return maskOneForLlm(src, row.spans);
  });
}

function buildTranscript(maskedMessages) {
  return maskedMessages.map((line, index) => `[${index + 1}] ${line}`).join('\n');
}

function unknownContextReview(reason, extra = {}) {
  return {
    ok: false,
    action: null,
    reason,
    ...extra,
  };
}

function parseContextReview(payload) {
  const parsed = extractJsonObject(payload);
  if (!parsed || typeof parsed !== 'object') {
    return unknownContextReview('invalid_llm_json');
  }
  if (parsed.confidence != null && !isValidConfidence(parsed.confidence)) {
    return unknownContextReview('invalid_llm_json');
  }
  const allowed = new Set(['archive', 'block', 'no_action']);
  const action = allowed.has(parsed.action) ? parsed.action : null;
  if (!action) return unknownContextReview('invalid_llm_action');
  return {
    ok: true,
    action,
    pitch: parsed.pitch === true,
    confidence: parsed.confidence ?? null,
    reason: parsed.reason != null ? String(parsed.reason).slice(0, 500) : '',
  };
}

async function reviewMaskedTranscript(transcript, options = {}) {
  const env = options.env || process.env;
  const cfg = { ...createLlmReviewConfig(env), ...options };
  const url = resolveChatCompletionsUrl(cfg.apiUrl);
  if (!url) return unknownContextReview('missing_api_url');
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return unknownContextReview('fetch_unavailable');
  }
  const messages = [
    { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
    { role: 'user', content: String(transcript || '') },
  ];
  const baseBody = {
    model: cfg.model || 'gpt-4o-mini',
    temperature: 0,
    messages,
  };
  try {
    const res = await postChatJson(url, baseBody, {
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs || 8000,
      fetchImpl,
    });
    if (!res.ok) return unknownContextReview('llm_http_error', { status: res.status });
    return parseContextReview(contentFromChatCompletion(res.json));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const reason = /timeout/i.test(message) ? 'llm_timeout' : 'llm_error';
    return unknownContextReview(reason, { error: message });
  }
}

/**
 * The big model may archive from no_action primary. It must not auto-block; a
 * model "block" answer is treated as archive only. When the review does not
 * archive, a pitch verdict only labels an unsaved sender's contact name and
 * leaves the chat in place. A failed or unknown review leaves the primary
 * decision alone (fail closed).
 */
function contextMeetsMinConfidence(review, env = process.env) {
  if (!review || review.ok !== true) return false;
  const min = llmReviewMinConfidence(env);
  const conf = review.confidence;
  return isValidConfidence(conf) && conf >= min;
}

function applyContextLlmDecision(decision, review, ctx = {}) {
  if (!decision || !review || review.ok === false) return decision;
  if (review.action === 'archive' || review.action === 'block') {
    if (contextMeetsMinConfidence(review, ctx.env || process.env)) {
      return {
        action: 'archive',
        archiveReason: 'context_llm',
      };
    }
  }
  if (review.pitch === true && ctx.savedContact === false && decision.action === 'ignore') {
    return {
      action: 'label',
      labelReason: 'context_llm_pitch',
      contactName: SUSPICIOUS_PITCH_CONTACT_NAME,
    };
  }
  return decision;
}

async function reviewOpeningMessages({
  messages,
  maskClient,
  llmOptions,
  env,
} = {}) {
  const list = Array.isArray(messages) ? messages.filter((line) => String(line || '').trim()) : [];
  if (!list.length) {
    return {
      trigger: { trigger: false, reasons: [], skipped: 'empty' },
      llmReview: null,
      redacted: null,
    };
  }
  if (!maskClient || typeof maskClient.maskMessages !== 'function') {
    return {
      trigger: { trigger: false, reasons: [], skipped: 'mask_unavailable' },
      llmReview: unknownContextReview('mask_unavailable'),
      redacted: null,
    };
  }
  let transcript;
  try {
    const maskResult = await maskClient.maskMessages(list);
    const masked = maskMessagesForLlm(list, maskResult);
    transcript = buildTranscript(masked);
  } catch (err) {
    return {
      trigger: { trigger: false, reasons: [], skipped: 'mask_failed' },
      llmReview: unknownContextReview('mask_failed', {
        error: err && err.message ? err.message : String(err),
      }),
      redacted: null,
    };
  }
  const llmReview = await reviewMaskedTranscript(transcript, {
    ...(llmOptions || {}),
    env,
  });
  return {
    trigger: { trigger: true, reasons: ['context_llm'], skipped: null },
    llmReview,
    redacted: transcript,
  };
}

module.exports = {
  DEFAULT_CONTEXT_LLM_MESSAGES,
  MAX_CONTEXT_LLM_MESSAGES,
  CONTEXT_SYSTEM_PROMPT,
  contextLlmEnabled,
  contextLlmMessageLimit,
  createRecentContext,
  maskOneForLlm,
  maskMessagesForLlm,
  buildTranscript,
  parseContextReview,
  reviewMaskedTranscript,
  contextMeetsMinConfidence,
  applyContextLlmDecision,
  reviewOpeningMessages,
};
