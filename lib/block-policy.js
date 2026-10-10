'use strict';

const DEFAULT_BLOCK_THRESHOLD = 80;

/** Short labels written into the WhatsApp contact name. */
const HEURISTIC_CONTACT_LABELS = {
  otp_expiry: '驗證碼過期',
  otp_harvest: '索取驗證碼',
  impersonation_solicitation: '假冒索取',
  fps_urgent_transfer: '轉數快即轉',
  wa_official_ban: '假官方封號',
  usdt_wallet_send: '加密貨幣轉帳',
  sf_customs_link: '順豐清關',
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
  if (blockReason === 'obvious_scam') {
    detail = HEURISTIC_CONTACT_LABELS[heuristicId] || '明顯詐騙';
  } else {
    const n = finiteNumber(score);
    detail = n == null ? '高分詐騙' : `高分${Math.round(n)}`;
  }
  return `封鎖·${detail}`.slice(0, 25);
}

/**
 * Unsaved contacts only.
 * Obvious-scam heuristics block even when the score is low.
 * A jevlike score, including one at or above BLOCK_THRESHOLD, only archives.
 * Saved contacts, grey scores, and scorer failures stay off this path.
 */
function blockEligibility({
  savedContact,
  scoreResult,
  heuristic,
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

  return null;
}

function applyBlockPolicy(decision, ctx = {}) {
  if (!decision || decision.action !== 'archive') return decision;
  const eligibility = blockEligibility(ctx);
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
