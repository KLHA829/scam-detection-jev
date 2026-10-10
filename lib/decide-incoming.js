'use strict';

const { scoreArchiveReason } = require('./scorer');

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function decideIncomingAction(
  scoreResult,
  _formattedNumber,
  _savedContact,
  _heuristic,
  rag,
  localClassifier,
) {
  const ragHit = Boolean(rag && rag.hit);
  const localHit = Boolean(localClassifier && localClassifier.hit);
  const label = scoreResult && scoreResult.label;
  const score =
    scoreResult && typeof scoreResult.score === 'number'
      ? scoreResult.score
      : 0;
  const archiveThreshold = finiteOr(
    scoreResult && scoreResult.thresholds && scoreResult.thresholds.archive,
    42,
  );

  if (label === 'scam' || score >= archiveThreshold) {
    return { action: 'archive', archiveReason: scoreArchiveReason(scoreResult) };
  }

  if (localHit) {
    return {
      action: 'archive',
      archiveReason:
        (localClassifier && localClassifier.archiveReason) ||
        'local_classifier',
    };
  }

  if (ragHit) {
    return {
      action: 'archive',
      archiveReason: (rag && rag.archiveReason) || 'rag_scam_match',
    };
  }

  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(scoreResult) {
  const heuristic = { hit: false, id: null, archiveReason: null };
  if (scoreResult && scoreResult.label === 'scam') {
    return {
      label: 'scam',
      archiveReason: scoreArchiveReason(scoreResult),
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
