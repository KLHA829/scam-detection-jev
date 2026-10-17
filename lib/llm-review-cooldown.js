'use strict';

const DEFAULT_COOLDOWN_MS = 600_000;

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function llmReviewCooldownMs(env = process.env) {
  const merged =
    env === process.env
      ? env
      : {
          ...process.env,
          ...env,
        };
  return envNumber(merged, 'LLM_REVIEW_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
}

function createLlmReviewCooldownStore() {
  const lastReviewByChat = new Map();
  return {
    get(chatId) {
      if (!chatId) return undefined;
      return lastReviewByChat.get(chatId);
    },
    set(chatId, ts) {
      if (!chatId) return;
      lastReviewByChat.set(chatId, ts);
    },
    clear() {
      lastReviewByChat.clear();
    },
  };
}

const defaultStore = createLlmReviewCooldownStore();

function resolveStore(store) {
  return store || defaultStore;
}

function isChatLlmCooldownActive(chatId, env = process.env, { store, now } = {}) {
  const ms = llmReviewCooldownMs(env);
  if (ms <= 0 || !chatId) return false;
  const last = resolveStore(store).get(chatId);
  if (last == null) return false;
  const t = now == null ? Date.now() : now;
  return t - last < ms;
}

/** Record after a completed primary or context LLM review (ok response). */
function recordChatLlmReviewSuccess(chatId, { store, now } = {}) {
  if (!chatId) return;
  resolveStore(store).set(chatId, now == null ? Date.now() : now);
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  llmReviewCooldownMs,
  createLlmReviewCooldownStore,
  isChatLlmCooldownActive,
  recordChatLlmReviewSuccess,
};
