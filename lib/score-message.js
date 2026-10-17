'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUBRIC_PATH = path.join(__dirname, '..', 'scoring-rubric.json');
const DEFAULT_JEVLIKE_MAX_CHARS = 2000;

function assignFiniteThreshold(raw, key, value, fallback) {
  if (value != null && value !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) raw.thresholds[key] = n;
  }
  if (!Number.isFinite(Number(raw.thresholds[key]))) {
    raw.thresholds[key] = fallback;
  }
}

function loadRubric(pathname = DEFAULT_RUBRIC_PATH, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(pathname, 'utf8'));
  assignFiniteThreshold(raw, 'archive', env.ARCHIVE_THRESHOLD, 42);
  assignFiniteThreshold(raw, 'safe', env.SAFE_THRESHOLD, 18);
  assignFiniteThreshold(raw, 'block', env.BLOCK_THRESHOLD, 80);
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

function scoreArchiveReason(scoreResult) {
  if (scoreResult && scoreResult.archiveReason) return scoreResult.archiveReason;
  return 'jevlike_score';
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
  scoreArchiveReason,
};
