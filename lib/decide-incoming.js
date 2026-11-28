// @ts-check
'use strict';

/**
 * Baseline inbound decision before masked LLM review.
 * No heuristic or score archives directly without AI confirmation.
 */
function decideIncomingAction() {
  return { action: 'ignore', archiveReason: null };
}

module.exports = {
  decideIncomingAction,
};
