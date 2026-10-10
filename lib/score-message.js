'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUBRIC_PATH = path.join(__dirname, '..', 'scoring-rubric.json');
const DEFAULT_JEVLIKE_MAX_CHARS = 2000;

function loadRubric(pathname = DEFAULT_RUBRIC_PATH, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(pathname, 'utf8'));
  if (env.ARCHIVE_THRESHOLD != null && env.ARCHIVE_THRESHOLD !== '') {
    const archive = Number(env.ARCHIVE_THRESHOLD);
    if (Number.isFinite(archive)) raw.thresholds.archive = archive;
  }
  if (env.SAFE_THRESHOLD != null && env.SAFE_THRESHOLD !== '') {
    const safe = Number(env.SAFE_THRESHOLD);
    if (Number.isFinite(safe)) raw.thresholds.safe = safe;
  }
  if (env.BLOCK_THRESHOLD != null && env.BLOCK_THRESHOLD !== '') {
    const block = Number(env.BLOCK_THRESHOLD);
    if (Number.isFinite(block)) raw.thresholds.block = block;
  }
  if (!Number.isFinite(Number(raw.thresholds.block))) {
    raw.thresholds.block = 80;
  }
  return raw;
}

function normalizeText(text, maxLen = 2000) {
  if (text == null) return '';
  return String(text).trim().slice(0, maxLen);
}

function labelFromScore(score, thresholds, { ok = true, empty = false } = {}) {
  if (empty || !ok) return 'unknown';
  if (score >= thresholds.archive) return 'scam';
  if (score <= thresholds.safe) return 'not_scam';
  return 'unknown';
}

function emptyScoreResult(
  rubric,
  { ok = true, reason = 'empty', error = null } = {},
) {
  return {
    score: 0,
    raw: 0,
    bonus: 0,
    breakdown: [],
    label: 'unknown',
    ok,
    empty: reason === 'empty',
    reason,
    error,
    thresholds: rubric.thresholds,
    scorer: 'jevlike',
    archiveReason: 'jevlike_score',
    prob_scam: null,
    prob_not_scam: null,
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function jevlikePayloadToScoreResult(payload, rubric) {
  const p = clamp01(payload && payload.prob_scam);
  const score = Number((p * 100).toFixed(4));
  const label = labelFromScore(score, rubric.thresholds, { ok: true });
  const pNot =
    payload && typeof payload.prob_not_scam === 'number'
      ? clamp01(payload.prob_not_scam)
      : Number((1 - p).toFixed(6));
  return {
    score,
    raw: score,
    bonus: 0,
    breakdown: [
      {
        id: 'scam',
        p,
        f: Number(p.toFixed(4)),
        weight: 100,
        contribution: score,
      },
    ],
    label,
    ok: true,
    empty: false,
    reason: null,
    error: null,
    thresholds: rubric.thresholds,
    scorer: 'jevlike',
    archiveReason: 'jevlike_score',
    prob_scam: p,
    prob_not_scam: pNot,
  };
}

function jevlikeMaxChars(rubric, env = process.env) {
  if (env.JEVLIKE_MAX_CHARS != null && env.JEVLIKE_MAX_CHARS !== '') {
    const n = Number(env.JEVLIKE_MAX_CHARS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (rubric && rubric.jevlikeMaxChars) return rubric.jevlikeMaxChars;
  return DEFAULT_JEVLIKE_MAX_CHARS;
}

async function scoreMessage(text, { client, rubric, cache, cacheKey, env } = {}) {
  if (!rubric) {
    throw new Error('rubric is required');
  }
  const normalized = normalizeText(text, jevlikeMaxChars(rubric, env || process.env));
  if (!normalized) {
    return emptyScoreResult(rubric, { ok: true, reason: 'empty' });
  }
  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
  }
  if (!client || typeof client.scoreText !== 'function') {
    return emptyScoreResult(rubric, {
      ok: false,
      reason: 'jevlike_error',
      error: 'jevlike client missing',
    });
  }
  try {
    const payload = await client.scoreText(normalized);
    const result = jevlikePayloadToScoreResult(payload, rubric);
    if (cache && cacheKey) cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return emptyScoreResult(rubric, {
      ok: false,
      reason: 'jevlike_error',
      error: err && err.message ? err.message : String(err),
    });
  }
}

module.exports = {
  DEFAULT_RUBRIC_PATH,
  DEFAULT_JEVLIKE_MAX_CHARS,
  loadRubric,
  normalizeText,
  labelFromScore,
  emptyScoreResult,
  jevlikePayloadToScoreResult,
  jevlikeMaxChars,
  scoreMessage,
};
