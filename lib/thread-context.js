'use strict';

const DEFAULT_CONTEXT_TURNS = 4;
const DEFAULT_BENIGN_MIN_CHARS = 24;

function envInt(env, key, fallback) {
  if (!env || env[key] == null || env[key] === '') return fallback;
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function contextTurnsFromEnv(env = process.env) {
  return envInt(env, 'CONTEXT_TURNS', DEFAULT_CONTEXT_TURNS);
}

function benignMinCharsFromEnv(env = process.env) {
  return envInt(env, 'CONTEXT_BENIGN_MIN_CHARS', DEFAULT_BENIGN_MIN_CHARS);
}

/**
 * In-memory inbound texts this process has already scored.
 * Capacity is CONTEXT_TURNS - 1 so the joined window (prior + current) stays
 * at CONTEXT_TURNS messages. Nothing is read back from WhatsApp.
 */
function createThreadContext({ turns = DEFAULT_CONTEXT_TURNS } = {}) {
  const priorCap = turns > 1 ? Math.floor(turns) - 1 : 0;
  const chats = new Map();
  return {
    turns: priorCap > 0 ? priorCap + 1 : Math.max(0, Math.floor(turns) || 0),
    prior(chatId) {
      if (!chatId) return [];
      return (chats.get(chatId) || []).slice();
    },
    remove(chatId, text) {
      const body = String(text || '').trim();
      const list = chats.get(chatId);
      if (!body || !list) return;
      const at = list.lastIndexOf(body);
      if (at !== -1) list.splice(at, 1);
    },
    push(chatId, text) {
      if (!priorCap || !chatId) return;
      const body = String(text || '').trim();
      if (!body) return;
      const list = chats.get(chatId) || [];
      list.push(body);
      while (list.length > priorCap) list.shift();
      chats.set(chatId, list);
    },
  };
}

/**
 * Prior messages oldest-first, then the current message.
 * The current message is kept whole. Oldest priors are dropped until the
 * join fits maxChars. A prior that does not fit is dropped entirely.
 */
function joinWindow(prior, current, maxChars) {
  const cur = String(current || '').trim();
  const max = Number(maxChars) > 0 ? Math.floor(maxChars) : cur.length;
  if (!cur) return '';
  if (cur.length >= max) return cur.slice(0, max);
  const parts = [cur];
  let used = cur.length;
  const older = Array.isArray(prior) ? prior : [];
  for (let i = older.length - 1; i >= 0; i -= 1) {
    const piece = String(older[i] || '').trim();
    if (!piece) continue;
    if (used + 1 + piece.length > max) break;
    parts.unshift(piece);
    used += 1 + piece.length;
  }
  return parts.join('\n');
}

function safeThreshold(single, rubric) {
  const fromScore = single && single.thresholds && Number(single.thresholds.safe);
  if (Number.isFinite(fromScore)) return fromScore;
  const fromRubric = rubric && rubric.thresholds && Number(rubric.thresholds.safe);
  if (Number.isFinite(fromRubric)) return fromRubric;
  return 18;
}

/**
 * Single score is the floor. A long, clearly safe sentence ignores the window
 * so an older lure cannot raise it. Otherwise the higher score wins, which
 * keeps a high current score from being diluted and lets a split lure surface.
 */
function pickContextScore({
  single,
  window,
  currentText,
  windowText,
  env = process.env,
  rubric,
} = {}) {
  const minChars = benignMinCharsFromEnv(env);
  const longBenign =
    single &&
    single.ok !== false &&
    Number(single.score) <= safeThreshold(single, rubric) &&
    String(currentText || '').trim().length > minChars;
  if (longBenign || !window) {
    return { scoreResult: single, text: currentText, source: 'single' };
  }
  if (Number(window.score) > Number(single.score)) {
    return { scoreResult: window, text: windowText, source: 'window' };
  }
  return { scoreResult: single, text: currentText, source: 'single' };
}

module.exports = {
  DEFAULT_CONTEXT_TURNS,
  DEFAULT_BENIGN_MIN_CHARS,
  contextTurnsFromEnv,
  benignMinCharsFromEnv,
  createThreadContext,
  joinWindow,
  pickContextScore,
};
