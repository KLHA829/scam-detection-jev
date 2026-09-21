'use strict';

const { LightJevClient } = require('./lightjev-client');
const { JevlikeClient } = require('./jevlike-client');

const JEVLIKE_NAMES = new Set(['jevlike', 'hf', 'hf-jevlike', 'hf_jevlike']);
const MODEL_V2_NAMES = new Set([
  'model_v2',
  'model-v2',
  'v2',
  'lightjev',
  'openjev',
]);

function normalizeScorer(raw, fallback = 'jevlike') {
  const name = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  if (!name) return fallback;
  if (JEVLIKE_NAMES.has(name)) return 'jevlike';
  if (MODEL_V2_NAMES.has(name)) return 'model_v2';
  return fallback;
}

/**
 * Primary scorer. Default jevlike (HF encoder head).
 * `model_v2` / `lightjev` keep the previous LightJev rubric worker.
 */
function resolveScorer(env = process.env) {
  return normalizeScorer(env && env.SCORER, 'jevlike');
}

function createScoreClient(env = process.env, extras = {}) {
  const name = resolveScorer(env);
  if (name === 'model_v2') {
    const client = new LightJevClient(extras);
    client.scorer = 'model_v2';
    return client;
  }
  return new JevlikeClient({ env, ...extras });
}

function clientScorerName(client, explicit) {
  if (explicit) return normalizeScorer(explicit, 'model_v2');
  if (client && client.scorer) return normalizeScorer(client.scorer, 'model_v2');
  if (client && typeof client.scoreText === 'function') return 'jevlike';
  return 'model_v2';
}

function scoreArchiveReason(scoreResult) {
  if (scoreResult && scoreResult.archiveReason) return scoreResult.archiveReason;
  const scorer = scoreResult && scoreResult.scorer;
  if (scorer === 'jevlike') return 'jevlike_score';
  return 'lightjev_score';
}

module.exports = {
  JEVLIKE_NAMES,
  MODEL_V2_NAMES,
  normalizeScorer,
  resolveScorer,
  createScoreClient,
  clientScorerName,
  scoreArchiveReason,
};
