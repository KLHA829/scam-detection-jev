'use strict';

class OpenJevError extends Error {
  constructor(status, bodyText) {
    super(`OpenJEV HTTP ${status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    this.name = 'OpenJevError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAnswers(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('invalid OpenJEV response');
  }
  if (json.answers && typeof json.answers === 'object') {
    return json.answers;
  }
  const skip = new Set(['model', 'usage', 'id', 'provider']);
  const out = {};
  for (const [key, value] of Object.entries(json)) {
    if (skip.has(key)) continue;
    if (
      value &&
      typeof value === 'object' &&
      ('noul' in value ||
        'type' in value ||
        'choice' in value ||
        'score' in value)
    ) {
      out[key] = value;
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error('invalid OpenJEV response');
  }
  return out;
}

class OpenJevClient {
  constructor({
    baseURL,
    apiKey,
    model,
    timeoutMs,
    fetchImpl,
  } = {}) {
    const env = process.env;
    this.baseURL = String(
      baseURL ||
        env.OPENJEV_BASE_URL ||
        env.TYPESAFE_BASE_URL ||
        'https://api.typesafe.ai',
    ).replace(/\/$/, '');
    this.apiKey =
      apiKey ?? env.OPENJEV_API_KEY ?? env.TYPESAFE_API_KEY ?? '';
    this.model = model || env.OPENJEV_MODEL || 'jev-latest';
    this.timeoutMs = Number(
      timeoutMs ?? env.OPENJEV_TIMEOUT_MS ?? 8000,
    );
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
        throw new Error('OpenJEV timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async systemOne({ state, questions, model } = {}) {
    if (!questions || Object.keys(questions).length === 0) {
      throw new Error('OpenJEV questions are required');
    }
    const url = `${this.baseURL}/v1/systemone`;
    const payload = {
      model: model || this.model,
      state,
      questions,
    };

    let lastRetryError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this._post(url, payload);
      if (res.status === 429 || res.status === 529) {
        lastRetryError = new OpenJevError(res.status, res.bodyText);
        if (attempt === 0) await sleep(200);
        continue;
      }
      if (!res.ok) {
        throw new OpenJevError(res.status, res.bodyText);
      }
      if (!res.json) {
        throw new Error('invalid OpenJEV response');
      }
      return parseAnswers(res.json);
    }
    throw lastRetryError || new Error('OpenJEV request failed');
  }
}

module.exports = {
  OpenJevClient,
  OpenJevError,
  parseAnswers,
};
