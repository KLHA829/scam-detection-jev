// @ts-check
'use strict';

const { isDirectArchiveHit } = require('./link-rules');

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

module.exports = {
  decideIncomingAction,
};
