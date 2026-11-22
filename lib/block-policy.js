'use strict';

/** Short labels written into the WhatsApp contact name. */
const HEURISTIC_CONTACT_LABELS = {
  lookalike_domain: '假域名',
  short_link_solicit: '短連結索取',
  malicious_host: '惡意域名',
  malicious_email_host: '惡意電郵網域',
};

function blockEnabled(env = process.env) {
  const v = env && env.BLOCK_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function contactNameForBlock() {
  return `封鎖·${HEURISTIC_CONTACT_LABELS.malicious_host}`.slice(0, 25);
}

/**
 * Unsaved contacts only.
 * Auto-block is limited to a maintained malicious-host list on the current message.
 * Blocklisted emails archive only. Lookalikes and soliciting short links require AI review.
 * Models and scores never block.
 * Saved contacts stay off this path.
 */
/** Written by the bot on an unsaved sender it judged a pitch; never archives by itself. */
const SUSPICIOUS_PITCH_CONTACT_NAME = '（可疑推銷）';

function isBotContactName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed === contactNameForBlock() || trimmed === SUSPICIOUS_PITCH_CONTACT_NAME;
}

/**
 * A contact the bot itself named (block or pitch label) is still an unsaved sender:
 * the label must not earn the saved-contact protection.
 */
function isOperatorSavedContact(contact) {
  return Boolean(contact && contact.isMyContact) && !isBotContactName(contact.name);
}

function isUnsavedContact(contact) {
  return Boolean(contact) &&
    (contact.isMyContact === false || (contact.isMyContact === true && isBotContactName(contact.name)));
}

function blockEligibility({
  savedContact,
  scoreResult,
  heuristic,
  env = process.env,
} = {}) {
  if (!blockEnabled(env)) return null;
  if (savedContact !== false) return null;

  if (heuristic && heuristic.hit && heuristic.id === 'malicious_host') {
    return {
      blockReason: 'malicious_host',
      heuristicId: 'malicious_host',
      contactName: contactNameForBlock({
        blockReason: 'malicious_host',
        heuristicId: 'malicious_host',
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
  HEURISTIC_CONTACT_LABELS,
  blockEnabled,
  contactNameForBlock,
  SUSPICIOUS_PITCH_CONTACT_NAME,
  isBotContactName,
  isOperatorSavedContact,
  isUnsavedContact,
  blockEligibility,
  applyBlockPolicy,
};
