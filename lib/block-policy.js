'use strict';

const DEFAULT_BLOCK_THRESHOLD = 80;

/** Short labels written into the WhatsApp contact name. */
const HEURISTIC_CONTACT_LABELS = {
  lookalike_domain: '假域名',
  short_link_solicit: '短連結索取',
};

function blockEnabled(env = process.env) {
  const v = env && env.BLOCK_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveBlockThreshold({ env = process.env, rubric, scoreResult } = {}) {
  return (
    finiteNumber(env && env.BLOCK_THRESHOLD) ??
    finiteNumber(scoreResult && scoreResult.thresholds && scoreResult.thresholds.block) ??
    finiteNumber(rubric && rubric.thresholds && rubric.thresholds.block) ??
    DEFAULT_BLOCK_THRESHOLD
  );
}

function contactNameForBlock({ blockReason, heuristicId, score } = {}) {
  let detail;
  if (blockReason === 'context_llm') {
    detail = '上文覆核';
  } else if (blockReason === 'obvious_scam') {
    detail = HEURISTIC_CONTACT_LABELS[heuristicId] || '明顯詐騙';
  } else {
    const n = finiteNumber(score);
    detail = n == null ? '高分詐騙' : `高分${Math.round(n)}`;
  }
  return `封鎖·${detail}`.slice(0, 25);
}

/**
 * Unsaved contacts only.
 * A link-rule hit blocks even when the score is low.
 * An explicit context-model block does the same.
 * A jevlike score, including one at or above BLOCK_THRESHOLD, only archives.
 * Saved contacts stay off this path.
 */
function blockEligibility({
  savedContact,
  scoreResult,
  heuristic,
  contextLlmBlock,
  env = process.env,
} = {}) {
  if (!blockEnabled(env)) return null;
  if (savedContact !== false) return null;

  if (heuristic && heuristic.hit) {
    const heuristicId = heuristic.id || null;
    return {
      blockReason: 'obvious_scam',
      heuristicId,
      contactName: contactNameForBlock({
        blockReason: 'obvious_scam',
        heuristicId,
        score: scoreResult && scoreResult.score,
      }),
    };
  }

  if (contextLlmBlock) {
    return {
      blockReason: 'context_llm',
      heuristicId: null,
      contactName: contactNameForBlock({
        blockReason: 'context_llm',
        score: scoreResult && scoreResult.score,
      }),
    };
  }

  return null;
}

function applyBlockPolicy(decision, ctx = {}) {
  if (!decision || decision.action !== 'archive') return decision;
  const eligibility = blockEligibility({
    ...ctx,
    contextLlmBlock: Boolean(decision.contextLlmBlock),
  });
  if (!eligibility) return decision;
  return {
    ...decision,
    action: 'block',
    blockReason: eligibility.blockReason,
    heuristicId: eligibility.heuristicId,
    contactName: eligibility.contactName,
  };
}

module.exports = {
  DEFAULT_BLOCK_THRESHOLD,
  HEURISTIC_CONTACT_LABELS,
  blockEnabled,
  resolveBlockThreshold,
  contactNameForBlock,
  blockEligibility,
  applyBlockPolicy,
};
