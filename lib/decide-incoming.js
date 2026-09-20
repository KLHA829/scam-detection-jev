'use strict';

const { isNonLocalDial } = require('./foreign-number');

function decideIncomingAction(
  scoreResult,
  formattedNumber,
  savedContact,
  heuristic,
) {
  const saved = Boolean(savedContact);
  const nonLocal = isNonLocalDial(formattedNumber);
  const heuristicHit = Boolean(heuristic && heuristic.hit);
  const label = scoreResult && scoreResult.label;
  const score =
    scoreResult && typeof scoreResult.score === 'number'
      ? scoreResult.score
      : 0;
  const archiveThreshold =
    (scoreResult &&
      scoreResult.thresholds &&
      Number(scoreResult.thresholds.archive)) ||
    42;

  if (label === 'scam' || score >= archiveThreshold) {
    return { action: 'archive', archiveReason: 'lightjev_score' };
  }

  if (heuristicHit) {
    return { action: 'archive', archiveReason: 'obvious_scam' };
  }

  if (!saved && nonLocal) {
    return { action: 'archive', archiveReason: 'foreign_number' };
  }

  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(scoreResult, text, env) {
  const { matchObviousScam } = require('./heuristics');
  const heuristic = matchObviousScam(text, env);
  if (scoreResult && scoreResult.label === 'scam') {
    return {
      label: 'scam',
      archiveReason: 'lightjev_score',
      heuristic,
    };
  }
  if (heuristic.hit) {
    return {
      label: 'scam',
      archiveReason: 'obvious_scam',
      heuristic,
    };
  }
  return {
    label: (scoreResult && scoreResult.label) || 'unknown',
    archiveReason: null,
    heuristic,
  };
}

module.exports = {
  decideIncomingAction,
  resolveIncomingMessageLabel,
};
