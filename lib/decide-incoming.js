'use strict';

const { matchObviousScam } = require('./link-rules');

function decideIncomingAction(
  _scoreResult,
  _formattedNumber,
  _savedContact,
  heuristic,
) {
  const heuristicHit = Boolean(heuristic && heuristic.hit);
  if (heuristicHit) {
    return {
      action: 'archive',
      archiveReason: (heuristic && heuristic.archiveReason) || 'obvious_scam',
    };
  }
  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(_scoreResult, text, env) {
  const heuristic = matchObviousScam(text, env);
  if (heuristic.hit) {
    return {
      label: 'scam',
      archiveReason: 'obvious_scam',
      heuristic,
    };
  }
  return {
    label: 'unknown',
    archiveReason: null,
    heuristic,
  };
}

module.exports = {
  decideIncomingAction,
  resolveIncomingMessageLabel,
};
