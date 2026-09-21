'use strict';

const { scoreArchiveReason } = require('./scorer');

function decideIncomingAction(
  scoreResult,
  _formattedNumber,
  _savedContact,
  heuristic,
  rag,
  localClassifier,
) {
  const heuristicHit = Boolean(heuristic && heuristic.hit);
  const ragHit = Boolean(rag && rag.hit);
  const localHit = Boolean(localClassifier && localClassifier.hit);
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
    return { action: 'archive', archiveReason: scoreArchiveReason(scoreResult) };
  }

  if (heuristicHit) {
    return {
      action: 'archive',
      archiveReason: (heuristic && heuristic.archiveReason) || 'obvious_scam',
    };
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

function resolveIncomingMessageLabel(scoreResult, text, env) {
  const { matchObviousScam } = require('./heuristics');
  const { shouldSuppress } = require('./scam-intent');
  const heuristic = matchObviousScam(text, env);
  if (scoreResult && scoreResult.label === 'scam') {
    if (shouldSuppress(text)) {
      return {
        label: scoreResult.label,
        archiveReason: null,
        heuristic,
        suppressed: true,
      };
    }
    return {
      label: 'scam',
      archiveReason: scoreArchiveReason(scoreResult),
      heuristic,
    };
  }
  if (heuristic.hit) {
    if (shouldSuppress(text)) {
      return {
        label: (scoreResult && scoreResult.label) || 'unknown',
        archiveReason: null,
        heuristic,
        suppressed: true,
      };
    }
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
