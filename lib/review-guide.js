'use strict';

const { maskMessagesForLlm, buildTranscript } = require('./context-llm');
const {
  contentFromChatCompletion,
  postChatJson,
  resolveChatCompletionsUrl,
  createLlmReviewConfig,
  withOfficialHosts,
} = require('./llm-review');
const { GUIDE_SYSTEM_PROMPT, parseGuide } = require('./review-prompt');

const GUIDE_MESSAGE_CAP = 10;

function recentReviewBodies(prior, current) {
  const list = [...(Array.isArray(prior) ? prior : []), current]
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  return list.slice(-GUIDE_MESSAGE_CAP);
}

function skipped(reason, extra = {}) {
  return { guide: null, redacted: null, skipped: reason, ...extra };
}

async function explainSuspicion({ messages, maskClient, maskCache, llmOptions, env = process.env } = {}) {
  const list = Array.isArray(messages)
    ? messages.map((line) => String(line || '').trim()).filter(Boolean).slice(-GUIDE_MESSAGE_CAP)
    : [];
  if (!list.length) return skipped('empty');
  if (!maskClient || typeof maskClient.maskMessages !== 'function') {
    return skipped('mask_unavailable');
  }

  let transcript;
  try {
    let masked;
    if (maskCache) {
      const cached = list.map((body) => maskCache.get(body));
      const seen = new Set();
      const pending = [];
      list.forEach((body, index) => {
        if (cached[index] != null || seen.has(body)) return;
        seen.add(body);
        pending.push(body);
      });
      const maskResult = await maskClient.maskMessages(pending);
      const freshMasked = maskMessagesForLlm(pending, maskResult);
      const fresh = new Map();
      pending.forEach((body, index) => {
        fresh.set(body, freshMasked[index]);
        maskCache.set(body, freshMasked[index]);
      });
      masked = list.map((body, index) => (cached[index] != null ? cached[index] : fresh.get(body)));
    } else {
      const maskResult = await maskClient.maskMessages(list);
      masked = maskMessagesForLlm(list, maskResult);
    }
    transcript = buildTranscript(masked);
  } catch (err) {
    return skipped('mask_failed', {
      error: err && err.message ? err.message : String(err),
    });
  }
  const cfg = { ...createLlmReviewConfig(env), ...(llmOptions || {}) };
  const url = resolveChatCompletionsUrl(cfg.apiUrl);
  if (!url) return skipped('missing_api_url', { redacted: transcript });

  const fetchImpl = cfg.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return skipped('fetch_unavailable', { redacted: transcript });

  const bodyMessages = [
    { role: 'system', content: withOfficialHosts(GUIDE_SYSTEM_PROMPT, transcript) },
    { role: 'user', content: transcript },
  ];
  const baseBody = {
    model: cfg.model || 'gpt-4o-mini',
    temperature: 0,
    messages: bodyMessages,
  };
  try {
    const res = await postChatJson(url, baseBody, {
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs || 8000,
      fetchImpl,
    });
    if (!res.ok) return skipped('llm_http_error', { redacted: transcript, status: res.status });
    const parsed = parseGuide(contentFromChatCompletion(res.json));
    if (!parsed.ok) return skipped('invalid_guide', { redacted: transcript });
    return { guide: parsed.guide, redacted: transcript, skipped: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const reason = /timeout/i.test(message) ? 'llm_timeout' : 'llm_error';
    return skipped(reason, { redacted: transcript, error: message });
  }
}

module.exports = {
  GUIDE_MESSAGE_CAP,
  recentReviewBodies,
  explainSuspicion,
};
