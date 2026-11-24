// @ts-check
'use strict';

const path = require('path');
const log = require('./log');
const { readJsonFile, writeJsonFileAtomic } = require('./json-store');

const DEFAULT_COOLDOWN_MS = 600_000;
const MAX_COOLDOWN_CHATS = 5000;

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

function defaultLlmReviewCooldownPath(env = process.env) {
  if (env && env.LLM_REVIEW_COOLDOWN_PATH) return env.LLM_REVIEW_COOLDOWN_PATH;
  return path.join(process.cwd(), 'llm-review-cooldown.json');
}

function readCooldownFile(filePath) {
  const res = readJsonFile(filePath);
  if (!res.ok) return { entries: {}, transientError: Boolean(res.transient) };
  const raw = res.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries: {}, transientError: false };
  }
  const entries = raw.lastReviewByChat;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { entries: {}, transientError: false };
  }
  return { entries, transientError: false };
}

function writeCooldownFile(filePath, lastReviewByChat) {
  writeJsonFileAtomic(filePath, { lastReviewByChat });
}

function pruneCooldownEntries(entries, cooldownMs, now) {
  const next = {};
  if (cooldownMs <= 0) return next;
  for (const [chatId, ts] of Object.entries(entries)) {
    const n = Number(ts);
    if (!chatId || !Number.isFinite(n)) continue;
    if (now - n < cooldownMs) next[chatId] = n;
  }
  return next;
}

/** @param {{ filePath?: string | null, env?: NodeJS.ProcessEnv }} [options] */
function createLlmReviewCooldownStore({ filePath = null, env = process.env } = {}) {
  const pathName = filePath || null;
  const lastReviewByChat = new Map();
  const cooldownEnv = env;
  let diskReadFailed = false;

  function pruneInMemory(now = Date.now()) {
    const ms = llmReviewCooldownMs(cooldownEnv);
    for (const [chatId, ts] of lastReviewByChat) {
      if (ms <= 0 || now - ts >= ms) lastReviewByChat.delete(chatId);
    }
    while (lastReviewByChat.size > MAX_COOLDOWN_CHATS) {
      lastReviewByChat.delete(lastReviewByChat.keys().next().value);
    }
  }

  function loadFromDisk() {
    if (!pathName) return;
    const now = Date.now();
    const ms = llmReviewCooldownMs(cooldownEnv);
    const loaded = readCooldownFile(pathName);
    diskReadFailed = loaded.transientError;
    const raw = loaded.entries;
    const pruned = pruneCooldownEntries(raw, ms, now);
    lastReviewByChat.clear();
    for (const [chatId, ts] of Object.entries(pruned)) {
      lastReviewByChat.set(chatId, ts);
    }
    pruneInMemory(now);
    if (!diskReadFailed && Object.keys(pruned).length !== Object.keys(raw).length) {
      try {
        writeCooldownFile(pathName, pruned);
      } catch (err) {
        log.warn('failed to save pruned LLM review cooldown', {
          error: err?.message ?? String(err),
        });
      }
    }
  }

  function persistToDisk() {
    if (!pathName) return;
    if (diskReadFailed) {
      const check = readCooldownFile(pathName);
      if (check.transientError) {
        throw new Error('refusing to overwrite LLM review cooldown after transient read failure');
      }
      diskReadFailed = false;
    }
    const now = Date.now();
    const ms = llmReviewCooldownMs(cooldownEnv);
    const obj = {};
    for (const [chatId, ts] of lastReviewByChat) {
      if (now - ts < ms) obj[chatId] = ts;
    }
    writeCooldownFile(pathName, obj);
  }

  if (pathName) loadFromDisk();

  return {
    path: pathName,
    get(chatId) {
      if (!chatId) return undefined;
      return lastReviewByChat.get(chatId);
    },
    set(chatId, ts) {
      if (!chatId) return;
      pruneInMemory(typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now());
      lastReviewByChat.delete(chatId);
      lastReviewByChat.set(chatId, ts);
      while (lastReviewByChat.size > MAX_COOLDOWN_CHATS) {
        lastReviewByChat.delete(lastReviewByChat.keys().next().value);
      }
      persistToDisk();
    },
    delete(chatId) {
      if (!chatId) return;
      lastReviewByChat.delete(chatId);
    },
    size() {
      return lastReviewByChat.size;
    },
    clear() {
      lastReviewByChat.clear();
      persistToDisk();
    },
    reload() {
      loadFromDisk();
    },
  };
}

const defaultStore = createLlmReviewCooldownStore();

function resolveStore(store) {
  return store || defaultStore;
}

/**
 * @param {string} chatId
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ store?: any, now?: number | null }} [options]
 */
function isChatLlmCooldownActive(chatId, env = process.env, { store = null, now = null } = {}) {
  const ms = llmReviewCooldownMs(env);
  if (ms <= 0 || !chatId) return false;
  const activeStore = resolveStore(store);
  const last = activeStore.get(chatId);
  if (last == null) return false;
  const t = now == null ? Date.now() : now;
  if (t - last < ms) return true;
  if (typeof activeStore.delete === 'function') activeStore.delete(chatId);
  return false;
}

/**
 * Record after a completed primary or context LLM review (ok response).
 * @param {string} chatId
 * @param {{ store?: any, now?: number | null }} [options]
 */
function recordChatLlmReviewSuccess(chatId, { store = null, now = null } = {}) {
  if (!chatId) return;
  try {
    resolveStore(store).set(chatId, now == null ? Date.now() : now);
  } catch (err) {
    log.warn('failed to persist LLM review cooldown', {
      chatId,
      error: err?.message ?? String(err),
    });
  }
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  llmReviewCooldownMs,
  defaultLlmReviewCooldownPath,
  createLlmReviewCooldownStore,
  isChatLlmCooldownActive,
  recordChatLlmReviewSuccess,
};
