'use strict';

const { matchLinkScam } = require('./link-rules');

function heuristicEnabled(env = process.env) {
  const v = env.HEURISTIC_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

/**
 * Hard hits are link rules only: lookalike hosts and soliciting short links.
 * Text tropes (OTP, 轉數快, 封號, 順豐清關) do not archive or block here.
 */
function matchObviousScam(text, env = process.env) {
  if (!heuristicEnabled(env)) {
    return { hit: false, id: null, archiveReason: null };
  }
  return matchLinkScam(text);
}

module.exports = {
  heuristicEnabled,
  matchObviousScam,
};
