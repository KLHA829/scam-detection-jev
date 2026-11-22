// @ts-check
'use strict';

const { isDirectArchiveHit, matchObviousScam } = require('./link-rules');

function decideIncomingAction(
  _scoreResult,
  _formattedNumber,
  _savedContact,
  heuristic,
) {
  if (isDirectArchiveHit(heuristic)) {
    return {
      action: 'archive',
      archiveReason: (heuristic && heuristic.archiveReason) || 'obvious_scam',
    };
  }
  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(_scoreResult, text, env) {
  const heuristic = matchObviousScam(text, env);
  if (isDirectArchiveHit(heuristic)) {
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
