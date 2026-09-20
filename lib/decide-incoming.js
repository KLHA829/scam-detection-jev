'use strict';

const { isNonLocalDial } = require('./foreign-number');

function pickOverlays(extras) {
  if (!extras) return { classifier: null, rag: null };
  if (extras.classifier || extras.rag) {
    return {
      classifier: extras.classifier || null,
      rag: extras.rag || null,
    };
  }
  if (
    'prob_scam' in extras ||
    extras.archiveReason === 'local_classifier_scam'
  ) {
    return { classifier: extras, rag: null };
  }
  if (extras.archiveReason === 'rag_scam_match') {
    return { classifier: null, rag: extras };
  }
  return { classifier: extras, rag: null };
}

function decideIncomingAction(
  scoreResult,
  formattedNumber,
  savedContact,
  heuristic,
  extras,
) {
  const saved = Boolean(savedContact);
  const nonLocal = isNonLocalDial(formattedNumber);
  const heuristicHit = Boolean(heuristic && heuristic.hit);
  const { classifier, rag } = pickOverlays(extras);
  const classifierHit = Boolean(classifier && classifier.hit);
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
    return { action: 'archive', archiveReason: 'lightjev_score' };
  }

  if (heuristicHit) {
    return { action: 'archive', archiveReason: 'obvious_scam' };
  }

  if (ragHit) {
    return {
      action: 'archive',
      archiveReason: (rag && rag.archiveReason) || 'rag_scam_match',
    };
  }

  if (classifierHit) {
    return {
      action: 'archive',
      archiveReason:
        (classifier && classifier.archiveReason) || 'local_classifier_scam',
    };
  }

  if (!saved && nonLocal) {
    return { action: 'archive', archiveReason: 'foreign_number' };
  }

  return { action: 'ignore', archiveReason: null };
}

function resolveIncomingMessageLabel(scoreResult, text, env, extras) {
  const { matchObviousScam } = require('./heuristics');
  const heuristic = matchObviousScam(text, env);
  const { classifier, rag } = pickOverlays(extras);
  if (scoreResult && scoreResult.label === 'scam') {
    return {
      label: 'scam',
      archiveReason: 'lightjev_score',
      heuristic,
      classifier: classifier || null,
      rag: rag || null,
    };
  }
  if (heuristic.hit) {
    return {
      label: 'scam',
      archiveReason: 'obvious_scam',
      heuristic,
      classifier: classifier || null,
      rag: rag || null,
    };
  }
  if (rag && rag.hit) {
    return {
      label: 'scam',
      archiveReason: (rag && rag.archiveReason) || 'rag_scam_match',
      heuristic,
      classifier: classifier || null,
      rag,
    };
  }
  if (classifier && classifier.hit) {
    return {
      label: 'scam',
      archiveReason:
        classifier.archiveReason || 'local_classifier_scam',
      heuristic,
      classifier,
      rag: rag || null,
    };
  }
  return {
    label: (scoreResult && scoreResult.label) || 'unknown',
    archiveReason: null,
    heuristic,
    classifier: classifier || null,
    rag: rag || null,
  };
}

module.exports = {
  decideIncomingAction,
  resolveIncomingMessageLabel,
  pickOverlays,
};
