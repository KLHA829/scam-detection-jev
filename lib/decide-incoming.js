'use strict';

const { isNonLocalDial } = require('./foreign-number');

function decideIncomingAction(
  scoreResult,
  formattedNumber,
  savedContact,
  heuristic,
  rag,
) {
  const saved = Boolean(savedContact);
  const nonLocal = isNonLocalDial(formattedNumber);
  const heuristicHit = Boolean(heuristic && heuristic.hit);
  const ragHit = Boolean(rag && rag.hit);
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
    return { action: 'archive', archiveReason: 'openjev_score' };
  }

  if (heuristicHit) {
    return {
      action: 'archive',
      archiveReason: (heuristic && heuristic.archiveReason) || 'obvious_scam',
    };
  }

  if (ragHit) {
    return {
      action: 'archive',
      archiveReason: (rag && rag.archiveReason) || 'rag_scam_match',
    };
  }

  if (!saved && nonLocal) {
    return { action: 'archive', archiveReason: 'foreign_number' };
  }

  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(scoreResult, text, env) {
  const { matchObviousScam } = require('./heuristics');
  const { matchRagScam } = require('./rag');
  const heuristic = matchObviousScam(text, env);
  const rag = matchRagScam(text, env);
  if (scoreResult && scoreResult.label === 'scam') {
    return {
      label: 'scam',
      archiveReason: 'openjev_score',
      heuristic,
      rag,
    };
  }
  if (heuristic.hit) {
    return {
      label: 'scam',
      archiveReason: 'obvious_scam',
      heuristic,
      rag,
    };
  }
  if (rag.hit) {
    return {
      label: 'scam',
      archiveReason: 'rag_scam_match',
      heuristic,
      rag,
    };
  }
  return {
    label: (scoreResult && scoreResult.label) || 'unknown',
    archiveReason: null,
    heuristic,
    rag,
  };
}

module.exports = {
  decideIncomingAction,
  resolveIncomingMessageLabel,
};
