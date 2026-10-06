'use strict';

class JevlikeError extends Error {
  constructor(status, bodyText) {
    super(
      `jevlike HTTP ${status}${bodyText ? `: ${String(bodyText).slice(0, 200)}` : ''}`,
    );
    this.name = 'JevlikeError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveMaskUrl(baseURL) {
  const trimmed = String(baseURL || '').replace(/\/$/, '');
  if (!trimmed) return 'http://127.0.0.1:8766/v1/mask';
  return `${trimmed}/v1/mask`;
}

function resolveScoreUrl(baseURL) {
  const trimmed = String(baseURL || '').replace(/\/$/, '');
  if (!trimmed) return 'http://127.0.0.1:8766/v1/score';
  if (/\/v1\/score$/i.test(trimmed) || /\/score$/i.test(trimmed) || /\/predict$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1/score`;
}

function parseProbScam(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.prob_scam === 'number' && Number.isFinite(payload.prob_scam)) {
    return payload.prob_scam;
  }
  const options = Array.isArray(payload.options) ? payload.options : [];
  const probs = Array.isArray(payload.probabilities) ? payload.probabilities : [];
  const idx = options.findIndex((name) => String(name).toLowerCase() === 'scam');
  if (idx >= 0 && typeof probs[idx] === 'number') return probs[idx];
  if (typeof payload.score === 'number' && Number.isFinite(payload.score)) {
    return payload.score / 100;
  }
  return null;
}

class JevlikeClient {
  constructor({
    baseURL,
    apiKey,
    timeoutMs,
    fetchImpl,
    env = process.env,
  } = {}) {
    this.scorer = 'jevlike';
    this.baseURL = String(
      baseURL || env.JEVLIKE_BASE_URL || 'http://127.0.0.1:8766',
    ).replace(/\/$/, '');
    this.apiKey = apiKey ?? env.JEVLIKE_API_KEY ?? '';
    this.timeoutMs = Number(timeoutMs ?? env.JEVLIKE_TIMEOUT_MS ?? 30000);
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
  }

  async _post(url, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { ok: res.ok, status: res.status, json, bodyText: text };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('jevlike timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the local worker which character ranges to hide.
   * The response must not be forwarded: it can be applied locally, then redacted again.
   */
  async maskMessages(messages) {
    const url = resolveMaskUrl(this.baseURL);
    const list = Array.isArray(messages) ? messages.map((item) => String(item == null ? '' : item)) : [];
    const res = await this._post(url, { messages: list });
    if (!res.ok || !res.json || !Array.isArray(res.json.messages)) {
      throw new JevlikeError(res.status || 0, res.bodyText);
    }
    return res.json;
  }

  /**
   * Score one message. Returns the worker JSON plus a guaranteed prob_scam.
   */
  async scoreText(text) {
    const url = resolveScoreUrl(this.baseURL);
    let lastRetryError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this._post(url, { text: String(text == null ? '' : text) });
      if (res.status === 429 || res.status === 529) {
        lastRetryError = new JevlikeError(res.status, res.bodyText);
        if (attempt === 0) await sleep(200);
        continue;
      }
      if (!res.ok) {
        throw new JevlikeError(res.status, res.bodyText);
      }
      if (!res.json) {
        throw new Error('invalid jevlike response');
      }
      const prob = parseProbScam(res.json);
      if (prob == null) {
        throw new Error('invalid jevlike response');
      }
      return { ...res.json, prob_scam: prob };
    }
    throw lastRetryError || new Error('jevlike request failed');
  }
}

module.exports = {
  JevlikeClient,
  JevlikeError,
  resolveScoreUrl,
  resolveMaskUrl,
  parseProbScam,
};
