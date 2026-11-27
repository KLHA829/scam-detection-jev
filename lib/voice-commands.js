// @ts-check
'use strict';

const DEFAULT_VOICE_ASR_BASE_URL = 'http://127.0.0.1:8768';

function envFlag(env, name, defaultValue = false) {
  const raw = env && env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function voiceCommandsEnabled(env = process.env) {
  return envFlag(env, 'VOICE_COMMANDS_ENABLED', false);
}

function timeoutMs(value, fallback = 30000) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function requireLoopbackBaseURL(baseURL) {
  const value = String(baseURL || DEFAULT_VOICE_ASR_BASE_URL);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VOICE_ASR_BASE_URL must be a valid loopback URL');
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !loopback) {
    throw new Error('VOICE_ASR_BASE_URL must use a loopback host so raw voice audio stays on this machine');
  }
  return value;
}

function resolveTranscribeUrl(baseURL) {
  const trimmed = String(baseURL || DEFAULT_VOICE_ASR_BASE_URL).replace(/\/+$/, '');
  if (/\/v1\/transcribe$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/v1$/i, '')}/v1/transcribe`;
}

function convertSpokenDigits(text) {
  const digits = {
    零: '0', 〇: '0', 一: '1', 二: '2', 兩: '2', 两: '2', 三: '3', 四: '4',
    五: '5', 六: '6', 七: '7', 八: '8', 九: '9',
  };
  return String(text || '').replace(/[零〇一二兩两三四五六七八九]/g, (ch) => digits[ch] || ch);
}

function normalizeVoiceTranscript(text) {
  return convertSpokenDigits(text)
    .trim()
    .replace(/(?:\p{Extended_Pictographic}\uFE0F?|\u200D)/gu, '')
    .replace(/[。！？!?，,、\s]+$/u, '')
    .replace(/[啦喇呀啊喎]+$/u, '')
    .replace(/^(?:唔該|唔该|請|请|麻煩|麻烦)+[，,、\s]*/u, '')
    .replace(/设定/g, '設定')
    .replace(/帮助/g, '幫助')
    .replace(/封锁/g, '封鎖')
    .trim();
}

class VoiceCommandClient {
  /** @param {{ baseURL?: string, apiKey?: string, timeoutMs?: number|string, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [options] */
  constructor({ baseURL, apiKey, timeoutMs: timeout, fetchImpl, env = process.env } = {}) {
    this.baseURL = requireLoopbackBaseURL(baseURL || env.VOICE_ASR_BASE_URL || DEFAULT_VOICE_ASR_BASE_URL);
    this.apiKey = apiKey ?? env.VOICE_ASR_API_KEY ?? '';
    this.timeoutMs = timeoutMs(timeout ?? env.VOICE_ASR_TIMEOUT_MS, 30000);
    this.language = env.VOICE_ASR_LANGUAGE || 'yue';
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch is not available');
  }

  /**
   * @param {{ dataBase64?: string, data?: string, mimetype?: string } | null} media
   * @param {{ context?: string }} [options]
   */
  async transcribeMedia(media, { context } = {}) {
    const audioBase64 = media && (media.dataBase64 || media.data);
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      throw new Error('voice media unavailable');
    }
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(resolveTranscribeUrl(this.baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          audioBase64,
          mimetype: media && media.mimetype ? String(media.mimetype) : '',
          language: this.language,
          ...(typeof context === 'string' ? { context } : {}),
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        throw new Error(`voice ASR HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
      }
      if (!json || typeof json.text !== 'string') {
        throw new Error('invalid voice ASR response');
      }
      return json.text;
    } finally {
      clearTimeout(timer);
    }
  }
}

function createVoiceCommandClient(env = process.env, extras = {}) {
  return new VoiceCommandClient({ env, ...extras });
}

module.exports = {
  VoiceCommandClient,
  createVoiceCommandClient,
  convertSpokenDigits,
  normalizeVoiceTranscript,
  requireLoopbackBaseURL,
  resolveTranscribeUrl,
  voiceCommandsEnabled,
};
