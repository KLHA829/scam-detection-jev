'use strict';

/**
 * Lab / eval only: call jevlike POST /v1/score via JevlikeClient.scoreText.
 * Live inbound does not import this module.
 */

const {
  loadRubric,
  normalizeText,
  jevlikeMaxChars,
  emptyScoreResult,
  jevlikePayloadToScoreResult,
} = require('../lib/score-message');

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
  loadRubric,
  scoreMessage,
};
