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

function resolveTimeoutMs(value) {
  if (value == null || value === '') return 30000;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 30000;
  return n;
}

function trimBaseUrl(baseURL) {
  return String(baseURL || '').replace(/\/+$/, '') ||
    'http://127.0.0.1:8766';
}

function resolveMaskUrl(baseURL) {
  let trimmed = trimBaseUrl(baseURL);
  if (/\/v1\/mask$/i.test(trimmed)) return trimmed;
  trimmed = trimmed.replace(/\/(?:v1\/score|score|predict|v1)$/i, '');
  return `${trimmed}/v1/mask`;
}

function assertCompleteMask(texts, rows) {
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new JevlikeError(200, 'incomplete mask');
  }
  for (let i = 0; i < texts.length; i += 1) {
    const row = rows[i];
    const text = texts[i];
    if (!row || typeof row !== 'object' || !Array.isArray(row.spans)) {
      throw new JevlikeError(200, 'incomplete mask');
    }
    for (const span of row.spans) {
      if (
        !span ||
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > text.length
      ) {
        throw new JevlikeError(200, 'incomplete mask');
      }
    }
  }
}

class JevlikeClient {
  constructor({
    baseURL,
    apiKey,
    timeoutMs,
    fetchImpl,
    env = process.env,
  } = {}) {
    this.baseURL = String(
      baseURL || env.JEVLIKE_BASE_URL || 'http://127.0.0.1:8766',
    );
    this.apiKey = apiKey ?? env.JEVLIKE_API_KEY ?? '';
    this.timeoutMs = resolveTimeoutMs(timeoutMs ?? env.JEVLIKE_TIMEOUT_MS ?? 30000);
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
        throw new Error('jevlike timeout', { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the local worker which character ranges to hide.
   * The response must not be forwarded. Apply the spans locally as typed placeholders.
   * A 200 that does not name a span list for every message is a failed mask.
   */
  async maskMessages(messages) {
    const url = resolveMaskUrl(this.baseURL);
    const list = Array.isArray(messages) ? messages.map((item) => String(item == null ? '' : item)) : [];
    const res = await this._post(url, { messages: list });
    if (!res.ok || !res.json || !Array.isArray(res.json.messages)) {
      throw new JevlikeError(res.status || 0, res.bodyText);
    }
    assertCompleteMask(list, res.json.messages);
    return res.json;
  }
}

function createMaskClient(env = process.env, extras = {}) {
  return new JevlikeClient({ env, ...extras });
}

module.exports = {
  JevlikeClient,
  JevlikeError,
  createMaskClient,
  resolveMaskUrl,
};
