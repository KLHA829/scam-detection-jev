'use strict';

const { contactNameForBlock } = require('./block-policy');
const { messageIdOf } = require('./self-chat');
const { explainSuspicion } = require('./review-guide');
const {
  REVIEW_POLL_NAME,
  REVIEW_OPTIONS,
  optionLabels,
  localFacts,
  buildReviewCard,
} = require('./review-prompt');

const POLL_FALLBACK = '投票出唔到。回覆呢條，打 1 封鎖並封存、2 只封存、3 留低。';

function reviewContactName(result, env, rubric) {
  if (result && result.savedContact) return null;
  if (result && result.decision && result.decision.contactName) {
    return result.decision.contactName;
  }
  const heuristic = result && result.heuristic && result.heuristic.hit ? result.heuristic : null;
  return contactNameForBlock({
    blockReason: heuristic ? 'obvious_scam' : 'jevlike_score',
    heuristicId: heuristic && heuristic.id,
    score: result && result.scoreResult && result.scoreResult.score,
  });
}

async function deliverGuidedReview({
  result,
  scoreClient,
  llmReview,
  env,
  rubric,
  queue,
  forward,
  sendText,
  sendPoll,
  allowDuplicate = false,
} = {}) {
  if (!result || !result.deferred) return { skipped: 'not_deferred' };
  const messageId = result.messageId || null;
  if (!allowDuplicate && queue && messageId && queue.findOpenByMessageId(messageId)) {
    return { skipped: 'duplicate' };
  }

  const facts = localFacts({
    scoreResult: result.scoreResult,
    decision: result.decision,
    heuristic: result.heuristic,
    savedContact: result.savedContact,
    pushName: result.pushName,
    digits: result.formattedNumber,
    env,
    rubric,
  });
  const explained = await explainSuspicion({
    messages: result.reviewMessages,
    scoreClient,
    llmOptions: llmReview,
    env,
  });
  const card = buildReviewCard({ facts, guide: explained.guide });

  let forwarded = false;
  let forwardError = null;
  if (typeof forward === 'function') {
    try {
      await forward();
      forwarded = true;
    } catch (err) {
      forwardError = err && err.message ? err.message : String(err);
    }
  }
  if (typeof sendText === 'function') {
    try {
      await sendText(card);
    } catch (err) {
      const cardError = err && err.message ? err.message : String(err);
      forwardError = forwardError || cardError;
    }
  }

  let pollId = null;
  if (typeof sendPoll === 'function') {
    try {
      pollId = messageIdOf(await sendPoll(REVIEW_POLL_NAME, optionLabels(REVIEW_OPTIONS)));
    } catch (err) {
      pollId = null;
      forwardError = forwardError || (err && err.message ? err.message : String(err));
    }
  }
  if (!pollId && typeof sendText === 'function') {
    try {
      pollId = messageIdOf(await sendText(POLL_FALLBACK));
    } catch (err) {
      pollId = null;
      forwardError = forwardError || (err && err.message ? err.message : String(err));
    }
  }
  if (!pollId || !queue) {
    return {
      skipped: pollId ? null : 'no_poll',
      forwarded,
      forwardError,
      guide: explained.guide,
      redacted: explained.redacted,
      card,
      pollId,
    };
  }

  const decision = result.decision || {};
  queue.add({
    pollId,
    messageId,
    chatId: result.chatId,
    digits: result.formattedNumber || null,
    savedContact: Boolean(result.savedContact),
    pushName: result.pushName || null,
    listName: result.listName || result.pushName || null,
    thresholds:
      (result.scoreResult && result.scoreResult.thresholds) ||
      (rubric && rubric.thresholds) ||
      null,
    score: result.scoreResult && result.scoreResult.score,
    label: result.scoreResult && result.scoreResult.label,
    archiveReason: decision.archiveReason || null,
    blockReason: decision.blockReason || null,
    heuristicId: (result.heuristic && result.heuristic.id) || decision.heuristicId || null,
    contactName: reviewContactName(result, env, rubric),
    proposedAction: decision.action,
    createdAt: new Date().toISOString(),
    resolved: false,
  });
  return {
    skipped: null,
    forwarded,
    forwardError,
    guide: explained.guide,
    redacted: explained.redacted,
    card,
    pollId,
  };
}

module.exports = {
  POLL_FALLBACK,
  reviewContactName,
  deliverGuidedReview,
};
