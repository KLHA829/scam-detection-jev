'use strict';

const { applyXxx } = require('./pii-xxx');
const { curatedMaliciousSpans, isCuratedMaliciousHit, officialHosts } = require('./link-rules');
const {
  isValidConfidence,
  contentFromChatCompletion,
  extractJsonObject,
  postChatJson,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
  llmReviewMinConfidence,
  withOfficialHosts,
  withCuratedHostNote,
} = require('./llm-review');
const { SUSPICIOUS_PITCH_CONTACT_NAME } = require('./block-policy');

const DEFAULT_CONTEXT_LLM_MESSAGES = 10;
const DEFAULT_MAX_CHATS = 1000;
const MAX_CONTEXT_LLM_MESSAGES = 10;

const CONTEXT_SYSTEM_PROMPT = [
  'You review the latest inbound WhatsApp messages of one chat, at most 10. The last line is the message that just arrived.',
  'Personal data has already been replaced with XXX. Do not try to reconstruct names, phones, accounts, IDs, or codes.',
  'Reply with ONE JSON object and no extra keys:',
  '{"action":"archive"|"block"|"no_action","pitch":true|false,"strong":true|false,"confidence":0-1,"reason":"short string"}',
  'block only for scam solicitation: OTP or password harvest, a money or FPS or PayMe transfer, impersonation plus secrecy, or a lure to log in or share information via a deceptive link.',
  'archive when you judge the chat to be a scam but there is no clear solicitation.',
  'no_action for ordinary chat (including a message saying money was already sent to the user, a bank alert that only reports a transaction or login on the user\'s own account, and a one-time code the user is told not to share), and for warnings that quote a suspicious link or tell the user NOT to send a code or money.',
  'Lines that start with "user:" are the user\'s own messages, shown for context; every other line is inbound from the other party. When the other party asks for payment, a deposit or details to complete a purchase, booking or service the user asked for in those lines, that is ordinary chat.',
  'If unsure, action no_action.',
  'Set pitch true when the chat is an unsolicited investment, trading or health-product pitch, whatever the action; otherwise false.',
  'Set strong true only when the other party asks for a one-time code, password or login, impersonates a bank, a payment service, the police, a government office or WhatsApp, or sends a link to a fake login or payment page; otherwise false.',
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
    push(chatId, text, { messageId, replaces, fromMe = false } = {}) {
      if (!chatId) return;
      const body = String(text || '').trim();
      const existing = chats.get(chatId);
      const old = String(replaces || '').trim();
      if (!body && !old && !messageId) return;
      const chat = existing || { list: [], inbound: 0, replied: false };
      const { list } = chat;
      const at = list.findLastIndex((entry) =>
        messageId ? entry.messageId === messageId : old && entry.fromMe === fromMe && entry.body === old);
      if (!body && at === -1) {
        if (!existing) return;
        return;
      }
      const turn = { messageId, fromMe, body };
      if (at !== -1 && fromMe && body) {
        list[at] = turn;
      } else {
        if (at !== -1) list.splice(at, 1);
        if (body) list.push(turn);
      }
      if (body && at === -1) {
        if (fromMe) chat.replied = true;
        else chat.inbound += 1;
      }
      while (list.length > cap) list.shift();
      chats.delete(chatId);
      chats.set(chatId, chat);
      if (chats.size > chatCap) chats.delete(chats.keys().next().value);
    },
    recent(chatId) {
      if (!chatId) return [];
      return (chats.get(chatId)?.list || []).map(({ fromMe, body }) => ({ fromMe, body }));
    },
    /**
     * Masked bodies of the chat's current turns, so each turn is masked once. The mask depends
     * on the text alone; an edit or a turn falling out of the window drops its entry.
     */
    maskCache(chatId) {
      const turns = () => chats.get(chatId)?.list || [];
      return {
        get: (body) => turns().find((entry) => entry.body === body && entry.masked != null)?.masked,
        set(body, masked) {
          for (const entry of turns()) if (entry.body === body) entry.masked = masked;
        },
      };
    },
    /** One inbound message so far and no reply from the user, however small the window. */
    firstContact(chatId) {
      const chat = chatId ? chats.get(chatId) : null;
      return Boolean(chat) && chat.inbound === 1 && !chat.replied;
    },
  };
}

/**
 * Mask spans minus brands' own domains, which are not personal data and which the model is
 * told are official; the rest of such a link stays masked.
 */
function spansOutsideOfficialHosts(text, spans) {
  const hosts = officialHosts(text);
  let out = Array.isArray(spans) ? spans : [];
  for (const { start, end } of hosts) {
    out = out.flatMap((span) => {
      if (!span || span.end < start || span.start > end) return [span];
      // A cut piece keeps a separator, so its XXX does not read as part of the domain.
      const pieces = [];
      const before = text[start - 1] === '@' ? start - 1 : start;
      if (span.start < before) pieces.push({ ...span, end: before, ...(before === start ? { replacement: 'XXX ' } : {}) });
      if (span.end > end) {
        const from = Math.max(span.start, end);
        pieces.push({ ...span, start: from, replacement: text[from] === '/' ? '/XXX' : ' XXX' });
      }
      return pieces;
    });
  }
  return out;
}

function maskOneForLlm(text, spans) {
  const src = String(text == null ? '' : text);
  const safeSpans = spansOutsideOfficialHosts(src, spans);
  const maliciousSpans = curatedMaliciousSpans(src);
  return applyXxx(src, maliciousSpans.length ? [...safeSpans, ...maliciousSpans] : safeSpans);
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

/** One line per turn: a line break inside a message cannot start a forged `user:` line. */
function buildChatTranscript(turns, maskedBodies) {
  return turns
    .map(({ fromMe }, index) => {
      const body = String(maskedBodies[index]).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
      return `[${index + 1}] ${fromMe ? 'user: ' : ''}${body}`;
    })
    .join('\n');
}

async function maskBodies(bodies, maskClient) {
  return maskMessagesForLlm(bodies, await maskClient.maskMessages(bodies));
}

const UNMASKABLE_TURN = '(message not shown)';

function isMaskTransportFailure(err) {
  if (!err) return false;
  if (err.status === 503 || err.name === 'AbortError') return true;
  const msg = err.message ? String(err.message) : String(err);
  return /timeout|timed out|aborted|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(msg);
}

function isMaskOversizeFailure(err) {
  if (!err) return false;
  if (err.status != null && err.status !== 422) return false;
  const msg = `${err.message || ''} ${err.bodyText || ''}`;
  return /message too long/i.test(msg);
}

/**
 * Mask the turns in one call. If that fails, isolate failed own turns and oversized historical
 * inbound turns as placeholders while keeping the current inbound turn and non-oversize inbound
 * errors strictly fail-closed. Transport/head-unavailable errors abort immediately.
 */
async function maskNewTurns(list, maskClient, { currentInboundIndex = -1 } = {}) {
  try {
    return await maskBodies(list.map(({ body }) => body), maskClient);
  } catch (err) {
    if (isMaskTransportFailure(err)) throw err;
    const hasOwn = list.some(({ fromMe }) => fromMe);
    const hasHistoricalInbound =
      isMaskOversizeFailure(err) &&
      list.some(({ fromMe }, idx) => !fromMe && idx !== currentInboundIndex);
    if (!hasOwn && !hasHistoricalInbound) throw err;

    if (hasHistoricalInbound) {
      let currentMasked = null;
      if (currentInboundIndex >= 0 && currentInboundIndex < list.length) {
        [currentMasked] = await maskBodies([list[currentInboundIndex].body], maskClient);
      }
      return Promise.all(
        list.map(({ body, fromMe }, idx) => {
          if (idx === currentInboundIndex) return Promise.resolve(currentMasked);
          if (fromMe) {
            return maskBodies([body], maskClient).then(([masked]) => masked, () => null);
          }
          return maskBodies([body], maskClient).then(
            ([masked]) => masked,
            (rowErr) => {
              if (isMaskOversizeFailure(rowErr)) return null;
              throw rowErr;
            },
          );
        }),
      );
    }
  }
  const inbound = await maskBodies(list.filter(({ fromMe }) => !fromMe).map(({ body }) => body), maskClient);
  const own = await Promise.all(list.filter(({ fromMe }) => fromMe).map(({ body }) =>
    maskBodies([body], maskClient).then(([masked]) => masked, () => null)));
  return list.map(({ fromMe }) => (fromMe ? own.shift() : inbound.shift()));
}

/**
 * Mask only the turns `maskCache` has not seen and remember them. The worker is asked even when
 * every turn is cached (an empty batch runs no encoder), so a worker without its PII head still
 * fails the review closed. An own turn (or oversized historical inbound turn) that cannot be
 * masked stays as a placeholder, while the current inbound turn still fails closed.
 */
async function maskTurns(list, maskClient, maskCache) {
  const known = list.map(({ body }) => maskCache?.get(body));
  let lastInboundIndex = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].fromMe) {
      lastInboundIndex = i;
      break;
    }
  }
  const pending = [];
  let currentInboundIndex = -1;
  list.forEach((turn, index) => {
    if (known[index] != null) return;
    if (index === lastInboundIndex) currentInboundIndex = pending.length;
    pending.push(turn);
  });
  const fresh = await maskNewTurns(pending, maskClient, { currentInboundIndex });
  return list.map(({ body }, index) => {
    if (known[index] != null) return known[index];
    const masked = fresh.shift();
    if (masked == null) return UNMASKABLE_TURN;
    maskCache?.set(body, masked);
    return masked;
  });
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
    pitch: typeof parsed.pitch === 'boolean' ? parsed.pitch : null,
    strong: parsed.strong === true,
    confidence: parsed.confidence ?? null,
    reason: parsed.reason != null ? String(parsed.reason).slice(0, 500) : '',
  };
}

function withFeedHostNote(systemPrompt, feedLines) {
  const lines = Array.isArray(feedLines) ? feedLines.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!lines.length) return systemPrompt;
  const list = lines.map((n) => `[${n}]`).join(' and ');
  return `${systemPrompt} Checked on this device: the link in message ${list} leads to a host on the PhishTank verified phishing feed. Treat that link as strong scam evidence; still judge whether the message is a warning about it rather than the scam itself.`;
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
  const systemPrompt = withFeedHostNote(
    withCuratedHostNote(
      withOfficialHosts(CONTEXT_SYSTEM_PROMPT, transcript),
      options.heuristic,
      { context: true },
    ),
    cfg.feedLines,
  );
  const messages = [
    { role: 'system', content: systemPrompt },
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

/** A confident no_action that says `pitch: false` lifts an earlier bot-written pitch label. */
function clearsPitchLabel(review, ctx = {}) {
  return ctx.savedContact === false &&
    review?.action === 'no_action' &&
    review.pitch === false &&
    contextMeetsMinConfidence(review, ctx.env || process.env);
}

function applyContextLlmDecision(decision, review, ctx = {}) {
  if (!decision || !review || review.ok === false) return decision;
  if (review.action === 'archive' || review.action === 'block') {
    const heldForMore =
      ctx.firstContact === true &&
      review.strong !== true &&
      !isCuratedMaliciousHit(ctx.heuristic);
    if (!heldForMore && contextMeetsMinConfidence(review, ctx.env || process.env)) {
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
  turns,
  maskClient,
  maskCache,
  llmOptions,
  heuristic,
  env,
} = {}) {
  const nonEmpty = Array.isArray(turns) ? turns.filter(({ body }) => String(body || '').trim()) : [];
  const list = nonEmpty.slice(-MAX_CONTEXT_LLM_MESSAGES);
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
    transcript = buildChatTranscript(list, await maskTurns(list, maskClient, maskCache));
  } catch (err) {
    return {
      trigger: { trigger: false, reasons: [], skipped: 'mask_failed' },
      llmReview: unknownContextReview('mask_failed', {
        error: err && err.message ? err.message : String(err),
      }),
      redacted: null,
    };
  }
  const linksOn = require('./link-rules').heuristicEnabled(env);
  const feedLines = [];
  try {
    const { feedHostHitsInText } = require('./link-rules');
    list.forEach((turn, index) => {
      if (linksOn && !turn.fromMe && feedHostHitsInText(turn.body)) feedLines.push(index + 1);
    });
  } catch {
    // feed annotation is best-effort; never block a review on it
  }
  const llmReview = await reviewMaskedTranscript(transcript, {
    ...(llmOptions || {}),
    feedLines: feedLines.length ? feedLines : (llmOptions || {}).feedLines,
    heuristic: heuristic ?? llmOptions?.heuristic,
    env,
  });
  return {
    trigger: { trigger: true, reasons: ['context_llm'], skipped: null },
    llmReview,
    redacted: transcript,
  };
}

module.exports = {
  clearsPitchLabel,
  DEFAULT_CONTEXT_LLM_MESSAGES,
  MAX_CONTEXT_LLM_MESSAGES,
  CONTEXT_SYSTEM_PROMPT,
  contextLlmEnabled,
  contextLlmMessageLimit,
  createRecentContext,
  maskOneForLlm,
  maskMessagesForLlm,
  buildTranscript,
  buildChatTranscript,
  parseContextReview,
  reviewMaskedTranscript,
  withFeedHostNote,
  contextMeetsMinConfidence,
  applyContextLlmDecision,
  reviewOpeningMessages,
};
