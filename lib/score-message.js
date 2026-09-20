'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUBRIC_PATH = path.join(__dirname, '..', 'scoring-rubric.json');

function loadRubric(pathname = DEFAULT_RUBRIC_PATH, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(pathname, 'utf8'));
  if (env.ARCHIVE_THRESHOLD != null && env.ARCHIVE_THRESHOLD !== '') {
    raw.thresholds.archive = Number(env.ARCHIVE_THRESHOLD);
  }
  if (env.SAFE_THRESHOLD != null && env.SAFE_THRESHOLD !== '') {
    raw.thresholds.safe = Number(env.SAFE_THRESHOLD);
  }
  if (env.NOISE_FLOOR != null && env.NOISE_FLOOR !== '') {
    raw.noiseFloor = Number(env.NOISE_FLOOR);
  }
  return raw;
}

function questionsFromRubric(rubric) {
  const questions = {};
  for (const dim of rubric.dimensions) {
    questions[dim.id] = dim.question;
  }
  return questions;
}

function normalizeText(text, maxLen = 2000) {
  if (text == null) return '';
  return String(text).trim().slice(0, maxLen);
}

function applyNoiseFloor(p, noiseFloor = 0.45) {
  if (typeof p !== 'number' || Number.isNaN(p)) return 0;
  const floor = Number(noiseFloor);
  if (p < floor) return 0;
  const span = 1 - floor;
  if (span <= 0) return p >= 1 ? 1 : 0;
  return (p - floor) / span;
}

function extractNoul(answer) {
  if (answer == null) return null;
  if (typeof answer === 'number') return answer;
  if (typeof answer.noul === 'number') return answer.noul;
  return null;
}

function aggregateScores(answers, rubric) {
  const breakdown = [];
  const fVals = {};
  let raw = 0;
  const noiseFloor = rubric.noiseFloor ?? 0.45;

  for (const dim of rubric.dimensions) {
    const p = extractNoul(answers && answers[dim.id]);
    const fv = applyNoiseFloor(p, noiseFloor);
    fVals[dim.id] = fv;
    const contribution = dim.weight * fv;
    raw += contribution;
    breakdown.push({
      id: dim.id,
      p,
      f: Number(fv.toFixed(4)),
      weight: dim.weight,
      contribution: Number(contribution.toFixed(4)),
    });
  }

  let bonus = 0;
  const moneyF = fVals.money || 0;
  const impersonationF = fVals.impersonation || 0;
  const loginF = fVals.login_ato || 0;
  const moneyMin = rubric.comboMoneyMin ?? 0.6;
  const otherMin = rubric.comboOtherMin ?? 0.55;
  if (moneyF >= moneyMin && (impersonationF >= otherMin || loginF >= otherMin)) {
    bonus = rubric.comboBonus ?? 12;
  }

  const score = Math.min(100, Number((raw + bonus).toFixed(4)));
  return { score, raw: Number(raw.toFixed(4)), bonus, breakdown, fVals };
}

function labelFromScore(score, thresholds, { ok = true, empty = false } = {}) {
  if (empty || !ok) return 'unknown';
  if (score >= thresholds.archive) return 'scam';
  if (score <= thresholds.safe) return 'not_scam';
  return 'unknown';
}

function emptyScoreResult(rubric, { ok = true, reason = 'empty', error = null } = {}) {
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
  };
}

async function scoreMessage(text, { client, rubric, cache, cacheKey } = {}) {
  if (!rubric) {
    throw new Error('rubric is required');
  }
  const normalized = normalizeText(text, rubric.maxStateChars);
  if (!normalized) {
    return emptyScoreResult(rubric, { ok: true, reason: 'empty' });
  }

  if (cache && cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  if (!client || typeof client.systemOne !== 'function') {
    return emptyScoreResult(rubric, {
      ok: false,
      reason: 'lightjev_error',
      error: 'LightJev client missing',
    });
  }

  try {
    const answers = await client.systemOne({
      state: normalized,
      questions: questionsFromRubric(rubric),
    });
    const agg = aggregateScores(answers, rubric);
    const label = labelFromScore(agg.score, rubric.thresholds, { ok: true });
    const result = {
      ...agg,
      label,
      ok: true,
      empty: false,
      reason: null,
      error: null,
      thresholds: rubric.thresholds,
    };
    if (cache && cacheKey) cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return emptyScoreResult(rubric, {
      ok: false,
      reason: 'lightjev_error',
      error: err && err.message ? err.message : String(err),
    });
  }
}

module.exports = {
  DEFAULT_RUBRIC_PATH,
  loadRubric,
  questionsFromRubric,
  normalizeText,
  applyNoiseFloor,
  extractNoul,
  aggregateScores,
  labelFromScore,
  emptyScoreResult,
  scoreMessage,
};
