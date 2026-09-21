'use strict';

const fs = require('fs');
const path = require('path');
const { clientScorerName } = require('./scorer');

const DEFAULT_RUBRIC_PATH = path.join(__dirname, '..', 'scoring-rubric.json');
const DEFAULT_JEVLIKE_MAX_CHARS = 2000;

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

function emptyScoreResult(
  rubric,
  { ok = true, reason = 'empty', error = null, scorer = 'model_v2' } = {},
) {
  const archiveReason = scorer === 'jevlike' ? 'jevlike_score' : 'lightjev_score';
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
    scorer,
    archiveReason,
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

async function scoreWithJevlike(text, { client, rubric, cache, cacheKey, env }) {
  const normalized = normalizeText(text, jevlikeMaxChars(rubric, env));
  if (!normalized) {
    return emptyScoreResult(rubric, { ok: true, reason: 'empty', scorer: 'jevlike' });
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
      scorer: 'jevlike',
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
      scorer: 'jevlike',
    });
  }
}

async function scoreWithModelV2(text, { client, rubric, cache, cacheKey }) {
  const normalized = normalizeText(text, rubric.maxStateChars);
  if (!normalized) {
    return emptyScoreResult(rubric, { ok: true, reason: 'empty', scorer: 'model_v2' });
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
      scorer: 'model_v2',
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
      scorer: 'model_v2',
      archiveReason: 'lightjev_score',
      prob_scam: Number((agg.score / 100).toFixed(6)),
      prob_not_scam: Number((1 - agg.score / 100).toFixed(6)),
    };
    if (cache && cacheKey) cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return emptyScoreResult(rubric, {
      ok: false,
      reason: 'lightjev_error',
      error: err && err.message ? err.message : String(err),
      scorer: 'model_v2',
    });
  }
}

async function scoreMessage(text, { client, rubric, cache, cacheKey, scorer, env } = {}) {
  if (!rubric) {
    throw new Error('rubric is required');
  }
  const name = clientScorerName(client, scorer);
  if (name === 'jevlike') {
    return scoreWithJevlike(text, {
      client,
      rubric,
      cache,
      cacheKey,
      env: env || process.env,
    });
  }
  return scoreWithModelV2(text, { client, rubric, cache, cacheKey });
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
  jevlikePayloadToScoreResult,
  scoreWithJevlike,
  scoreWithModelV2,
  scoreMessage,
};
