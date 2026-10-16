'use strict';

const { scoreArchiveReason } = require('./score-message');
const { matchObviousScam } = require('./link-rules');

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function decideIncomingAction(
  scoreResult,
  _formattedNumber,
  _savedContact,
  heuristic,
) {
  const heuristicHit = Boolean(heuristic && heuristic.hit);
  const label = scoreResult && scoreResult.label;
  const score =
    scoreResult && typeof scoreResult.score === 'number'
      ? scoreResult.score
      : 0;
  const archiveThreshold = finiteOr(
    scoreResult && scoreResult.thresholds && scoreResult.thresholds.archive,
    42,
  );

  const scoreOk = !scoreResult || scoreResult.ok !== false;
  if (scoreOk && (label === 'scam' || score >= archiveThreshold)) {
    return { action: 'archive', archiveReason: scoreArchiveReason(scoreResult) };
  }

  if (heuristicHit) {
    return {
      action: 'archive',
      archiveReason: (heuristic && heuristic.archiveReason) || 'obvious_scam',
    };
  }

  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(scoreResult, text, env) {
  const heuristic = matchObviousScam(text, env);
  if (scoreResult && scoreResult.label === 'scam') {
    return {
      label: 'scam',
      archiveReason: scoreArchiveReason(scoreResult),
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
  scoreArchiveReason,
};
