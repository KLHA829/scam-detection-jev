'use strict';

const fs = require('fs');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_GAP_MS = 3000;
const DEFAULT_MAX_PER_HOUR = 6;
const DEFAULT_REPEAT_MS = 6 * HOUR_MS;

function envInt(env, key, fallback) {
  if (!env || env[key] == null || env[key] === '') return fallback;
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function rememberKey(acted, key, kind, at) {
  if (key == null || key === '') return;
  acted.set(String(key), { kind, at });
}

function loadBlockedKeys(logPath, readFile, acted, now) {
  let text = '';
  try {
    text = readFile(logPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    return;
  }
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || !row.blocked) continue;
      const at = Date.parse(row.at);
      const stamp = Number.isFinite(at) ? at : now();
      rememberKey(acted, row.digits, 'block', stamp);
      rememberKey(acted, row.chatId, 'block', stamp);
    } catch {
      /* ignore a torn line */
    }
  }
}

function createActionPacer({
  env = process.env,
  logPath,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readFile = fs.readFileSync,
} = {}) {
  const gapMs = envInt(env, 'WA_ACTION_GAP_MS', DEFAULT_GAP_MS);
  const maxPerHour = envInt(env, 'BLOCK_MAX_PER_HOUR', DEFAULT_MAX_PER_HOUR);
  const repeatMs = envInt(env, 'ACTION_REPEAT_MS', DEFAULT_REPEAT_MS);
  const acted = new Map();
  let blockTimes = [];
  let lastAt = 0;
  let chain = Promise.resolve();

  if (logPath) loadBlockedKeys(logPath, readFile, acted, now);

  function blockedKey(chatId, digits) {
    const a = digits != null && digits !== '' ? acted.get(String(digits)) : null;
    const b = chatId != null && chatId !== '' ? acted.get(String(chatId)) : null;
    return (a && a.kind === 'block') || (b && b.kind === 'block');
  }

  function recentlyArchived(chatId, digits) {
    const row =
      (digits != null && digits !== '' && acted.get(String(digits))) ||
      (chatId != null && chatId !== '' && acted.get(String(chatId))) ||
      null;
    if (!row || row.kind !== 'archive') return false;
    return now() - row.at < repeatMs;
  }

  function evaluate({ action, chatId, digits, alreadyBlocked } = {}) {
    if (alreadyBlocked || blockedKey(chatId, digits) || recentlyArchived(chatId, digits)) {
      return { proceed: false, action: 'ignore', reason: 'already_acted' };
    }
    if (action === 'block' && maxPerHour > 0) {
      const cutoff = now() - HOUR_MS;
      blockTimes = blockTimes.filter((t) => t >= cutoff);
      if (blockTimes.length >= maxPerHour) {
        return { proceed: true, action: 'archive', reason: 'hourly_cap' };
      }
      blockTimes.push(now());
    }
    return { proceed: true, action, reason: null };
  }

  function note({ action, chatId, digits } = {}) {
    const at = now();
    const kind = action === 'block' ? 'block' : 'archive';
    rememberKey(acted, digits, kind, at);
    rememberKey(acted, chatId, kind, at);
  }

  async function pause() {
    if (gapMs <= 0) return;
    const t = now();
    if (lastAt !== 0) {
      const wait = lastAt + gapMs - t;
      if (wait > 0) await sleep(wait);
    }
    lastAt = now();
  }

  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    evaluate,
    note,
    pause,
    exclusive,
    gapMs,
    maxPerHour,
    repeatMs,
  };
}

module.exports = {
  HOUR_MS,
  DEFAULT_GAP_MS,
  DEFAULT_MAX_PER_HOUR,
  DEFAULT_REPEAT_MS,
  createActionPacer,
};
