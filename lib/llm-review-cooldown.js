'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

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

function defaultLlmReviewCooldownPath(env = process.env) {
  if (env && env.LLM_REVIEW_COOLDOWN_PATH) return env.LLM_REVIEW_COOLDOWN_PATH;
  return path.join(process.cwd(), 'llm-review-cooldown.json');
}

function readCooldownFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const entries = raw.lastReviewByChat;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
    return entries;
  } catch {
    return {};
  }
}

function writeCooldownFile(filePath, lastReviewByChat) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ lastReviewByChat }, null, 2)}\n`,
    'utf8',
  );
  fs.renameSync(tmp, filePath);
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

function createLlmReviewCooldownStore({ filePath, env = process.env } = {}) {
  const pathName = filePath || null;
  const lastReviewByChat = new Map();
  const cooldownEnv = env;

  function loadFromDisk() {
    if (!pathName) return;
    const now = Date.now();
    const ms = llmReviewCooldownMs(cooldownEnv);
    const raw = readCooldownFile(pathName);
    const pruned = pruneCooldownEntries(raw, ms, now);
    lastReviewByChat.clear();
    for (const [chatId, ts] of Object.entries(pruned)) {
      lastReviewByChat.set(chatId, ts);
    }
    if (Object.keys(pruned).length !== Object.keys(raw).length) {
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
      lastReviewByChat.set(chatId, ts);
      persistToDisk();
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
