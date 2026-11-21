'use strict';

const DEFAULT_CONTEXT_TURNS = 4;

function envInt(env, key, fallback) {
  if (!env || env[key] == null || env[key] === '') return fallback;
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function contextTurnsFromEnv(env = process.env) {
  return envInt(env, 'CONTEXT_TURNS', DEFAULT_CONTEXT_TURNS);
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

module.exports = {
  DEFAULT_CONTEXT_TURNS,
  contextTurnsFromEnv,
  createThreadContext,
};
