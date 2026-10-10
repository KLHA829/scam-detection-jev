'use strict';

const { applyXxx } = require('./mask-spans');
const { contactNameForBlock, resolveBlockThreshold } = require('./block-policy');
const {
  contentFromChatCompletion,
  postChatCompletions,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
} = require('./llm-review');

const DEFAULT_CONTEXT_LLM_MESSAGES = 10;
const MAX_CONTEXT_LLM_MESSAGES = 10;

const CONTEXT_SYSTEM_PROMPT = [
  'You review the latest inbound WhatsApp messages of one chat, at most 10. The last line is the message that just arrived.',
  'Personal data has already been replaced with XXX. Do not try to reconstruct names, phones, accounts, IDs, or codes.',
  'Reply with ONE JSON object and no extra keys:',
  '{"action":"archive"|"block"|"no_action","reason":"short string"}',
  'block only when you are sure the chat is a scam: OTP or password harvest, a money or FPS or PayMe transfer, or impersonation plus secrecy.',
  'archive when the chat is suspicious but you are not sure enough to block.',
  'no_action for ordinary chat, for warnings that tell the user NOT to send a code or money, and whenever you are unsure.',
].join(' ');

function envFlag(env, name, defaultValue = false) {
  const v = env[name];
  if (v == null || v === '') return defaultValue;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function contextLlmEnabled(env = process.env) {
  return envFlag(env, 'CONTEXT_LLM_ENABLED', false);
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
 */
function createRecentContext({ limit = DEFAULT_CONTEXT_LLM_MESSAGES } = {}) {
  const cap = Math.min(
    MAX_CONTEXT_LLM_MESSAGES,
    Math.max(1, Math.floor(Number(limit) || DEFAULT_CONTEXT_LLM_MESSAGES)),
  );
  const chats = new Map();
  return {
    limit: cap,
    push(chatId, text) {
      if (!chatId) return;
      const body = String(text || '').trim();
      if (!body) return;
      const list = chats.get(chatId) || [];
      list.push(body);
      while (list.length > cap) list.shift();
      chats.set(chatId, list);
    },
    recent(chatId) {
      if (!chatId) return [];
      return (chats.get(chatId) || []).slice();
    },
  };
}

function maskOneForLlm(text, spans) {
  return applyXxx(text, spans);
}

function maskMessagesForLlm(messages, maskResult) {
  const rows = maskResult && Array.isArray(maskResult.messages) ? maskResult.messages : [];
  return messages.map((text, index) => {
    const row = rows[index];
    const spans = row && Array.isArray(row.spans) ? row.spans : [];
    return maskOneForLlm(text, spans);
  });
}

function buildTranscript(maskedMessages) {
  return maskedMessages.map((line, index) => `[${index + 1}] ${line}`).join('\n');
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
  const allowed = new Set(['archive', 'block', 'no_action']);
  const action = allowed.has(parsed.action) ? parsed.action : null;
  if (!action) return unknownContextReview('invalid_llm_action');
  return {
    ok: true,
    action,
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
    let res = await postChatCompletions(
      url,
      { ...baseBody, response_format: { type: 'json_object' } },
      {
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs || 8000,
        fetchImpl,
      },
    );
    if (res.status === 400) {
      res = await postChatCompletions(url, baseBody, {
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs || 8000,
        fetchImpl,
      });
    }
    if (!res.ok) return unknownContextReview('llm_http_error', { status: res.status });
    return parseContextReview(contentFromChatCompletion(res.json));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const reason = /timeout/i.test(message) ? 'llm_timeout' : 'llm_error';
    return unknownContextReview(reason, { error: message });
  }
}

/**
 * After the model has read the latest inbound messages, block means it is
 * sure the chat is a scam. That blocks an unsaved contact. A saved contact
 * is archived instead. archive does not block. no_action can release a
 * score-only archive below the block line. A failed review leaves the
 * primary decision alone.
 */
function applyContextLlmDecision(decision, review, ctx = {}) {
  if (!decision || !review || review.ok === false) return decision;
  if (review.action === 'no_action') {
    const scoreResult = ctx && ctx.scoreResult;
    const score = Number(scoreResult && scoreResult.score);
    const belowBlockLine =
      Boolean(scoreResult && scoreResult.label === 'scam') &&
      Number.isFinite(score) &&
      score < resolveBlockThreshold(ctx);
    if (
      decision.action === 'archive' &&
      decision.archiveReason === 'jevlike_score' &&
      belowBlockLine
    ) {
      return {
        action: 'ignore',
        archiveReason: null,
        released: true,
        releaseReason: 'context_llm_no_action',
      };
    }
    return decision;
  }
  if (review.action === 'block' && ctx && ctx.savedContact === false) {
    const scoreResult = ctx.scoreResult;
    return {
      action: 'block',
      archiveReason: 'context_llm',
      blockReason: 'context_llm',
      contactName: contactNameForBlock({
        blockReason: 'context_llm',
        score: scoreResult && scoreResult.score,
      }),
    };
  }
  if (review.action === 'archive' || review.action === 'block') {
    return { action: 'archive', archiveReason: 'context_llm' };
  }
  return decision;
}

async function reviewOpeningMessages({
  messages,
  scoreClient,
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
  if (!scoreClient || typeof scoreClient.maskMessages !== 'function') {
    return {
      trigger: { trigger: false, reasons: [], skipped: 'mask_unavailable' },
      llmReview: unknownContextReview('mask_unavailable'),
      redacted: null,
    };
  }
  let maskResult;
  try {
    maskResult = await scoreClient.maskMessages(list);
  } catch (err) {
    return {
      trigger: { trigger: false, reasons: [], skipped: 'mask_failed' },
      llmReview: unknownContextReview('mask_failed', {
        error: err && err.message ? err.message : String(err),
      }),
      redacted: null,
    };
  }
  const masked = maskMessagesForLlm(list, maskResult);
  const transcript = buildTranscript(masked);
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
  applyContextLlmDecision,
  reviewOpeningMessages,
};
