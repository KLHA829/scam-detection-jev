'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8099/v1/score';
const DEFAULT_THRESH = 0.85;
const DEFAULT_TIMEOUT_MS = 3000;

function envFlag(name, defaultValue, env = process.env) {
  const v = env[name];
  if (v == null || v === '') return defaultValue;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function classifierEnabled(env = process.env) {
  return envFlag('SCAM_CLASSIFIER_ENABLED', false, env);
}

function classifierThreshold(env = process.env) {
  const raw = env.SCAM_CLASSIFIER_THRESH;
  if (raw == null || raw === '') return DEFAULT_THRESH;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_THRESH;
}

function classifierTimeoutMs(env = process.env) {
  const raw = env.SCAM_CLASSIFIER_TIMEOUT_MS;
  if (raw == null || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function looksZhYue(text) {
  return /[\u3400-\u9fff\uF900-\uFAFF]/.test(String(text || ''));
}

function resolveScoreUrl(base, env = process.env) {
  const raw = String(
    base || env.SCAM_CLASSIFIER_URL || DEFAULT_URL,
  ).trim();
  if (!raw) return DEFAULT_URL;
  if (/\/v1\/score\/?$/i.test(raw) || /\/score\/?$/i.test(raw)) {
    return raw.replace(/\/$/, '');
  }
  return `${raw.replace(/\/$/, '')}/v1/score`;
}

function emptyClassifierResult(overrides = {}) {
  return {
    ok: true,
    hit: false,
    skipped: true,
    reason: 'disabled',
    label: null,
    prob_scam: null,
    threshold: DEFAULT_THRESH,
    archiveReason: null,
    error: null,
    axes: null,
    ...overrides,
  };
}

function parseProb(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const n = Number(payload.prob_scam);
  return Number.isFinite(n) ? n : null;
}

async function scoreLocalClassifier(
  text,
  { env = process.env, fetchImpl, timeoutMs, url } = {},
) {
  const thresh = classifierThreshold(env);
  if (!classifierEnabled(env)) {
    return emptyClassifierResult({ reason: 'disabled', threshold: thresh });
  }

  const body = text == null ? '' : String(text).trim();
  if (!body) {
    return emptyClassifierResult({ reason: 'empty', threshold: thresh });
  }
  if (!looksZhYue(body)) {
    return emptyClassifierResult({ reason: 'not_zh_yue', threshold: thresh });
  }

  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return emptyClassifierResult({
      ok: false,
      skipped: false,
      reason: 'error',
      error: 'fetch is not available',
      threshold: thresh,
    });
  }

  const endpoint = resolveScoreUrl(url, env);
  const ms = timeoutMs != null ? Number(timeoutMs) : classifierTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms > 0 ? ms : DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: body }),
      signal: controller.signal,
    });
    const raw = await res.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      return emptyClassifierResult({
        ok: false,
        skipped: false,
        reason: 'http_error',
        error: `classifier HTTP ${res.status}`,
        threshold: thresh,
      });
    }
    const prob = parseProb(payload);
    if (prob == null) {
      return emptyClassifierResult({
        ok: false,
        skipped: false,
        reason: 'invalid_response',
        error: 'missing prob_scam',
        threshold: thresh,
      });
    }
    const hit = prob >= thresh;
    const serverLabel =
      payload && typeof payload.label === 'string' ? payload.label : null;
    const axes =
      payload && payload.axes && typeof payload.axes === 'object'
        ? payload.axes
        : null;
    return {
      ok: true,
      hit,
      skipped: false,
      reason: null,
      label: serverLabel || (hit ? 'scam' : 'not_scam'),
      prob_scam: prob,
      threshold: thresh,
      archiveReason: hit ? 'local_classifier_scam' : null,
      error: null,
      axes,
    };
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return emptyClassifierResult({
      ok: false,
      skipped: false,
      reason: isTimeout ? 'timeout' : 'error',
      error: isTimeout
        ? 'classifier timeout'
        : err && err.message
          ? err.message
          : String(err),
      threshold: thresh,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_URL,
  DEFAULT_THRESH,
  DEFAULT_TIMEOUT_MS,
  classifierEnabled,
  classifierThreshold,
  classifierTimeoutMs,
  looksZhYue,
  resolveScoreUrl,
  emptyClassifierResult,
  scoreLocalClassifier,
};
