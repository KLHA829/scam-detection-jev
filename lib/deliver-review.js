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

const deliveries = new WeakMap();

function invalidatePendingGuidedReview(queue, messageId) {
  const pending = deliveries.get(queue)?.pending.get(messageId);
  if (!pending || pending.cancelled) return 0;
  pending.cancelled = true;
  return 1;
}

async function deliverGuidedReview(options = {}) {
  const { result, queue } = options;
  if (!result || !result.deferred) return { skipped: 'not_deferred' };
  if (!queue) return prepareGuidedReview(options);
  let state = deliveries.get(queue);
  if (!state) {
    state = { pending: new Map(), chats: new Map() };
    deliveries.set(queue, state);
  }
  const messageId = result.messageId;
  if (messageId && ((state.pending.has(messageId) && !state.pending.get(messageId).cancelled) || queue.findOpenByMessageId(messageId))) {
    return { skipped: 'duplicate' };
  }
  const delivery = queue.beginDelivery(messageId);
  const pending = { cancelled: false };
  if (messageId) state.pending.set(messageId, pending);
  const previous = state.chats.get(result.chatId) || Promise.resolve();
  const run = previous.then(() => prepareGuidedReview({
    ...options, delivery, isCurrent: () => !pending.cancelled && !delivery.resolved,
  }));
  const settled = run.catch(() => {});
  state.chats.set(result.chatId, settled);
  try {
    return await run;
  } finally {
    queue.endDelivery(delivery);
    if (messageId && state.pending.get(messageId) === pending) state.pending.delete(messageId);
    if (state.chats.get(result.chatId) === settled) state.chats.delete(result.chatId);
  }
}

function reviewContactName(result) {
  if (result && result.savedContact) return null;
  if (result && result.decision && result.decision.contactName) {
    return result.decision.contactName;
  }
  const heuristic = result && result.heuristic && result.heuristic.hit ? result.heuristic : null;
  return contactNameForBlock({
    blockReason: heuristic ? 'obvious_scam' : 'llm_review',
    heuristicId: heuristic && heuristic.id,
  });
}

async function prepareGuidedReview({
  result,
  maskClient,
  llmReview,
  env,
  queue,
  delivery,
  forward,
  sendText,
  sendPoll,
  exclusive = (fn) => fn(),
  isCurrent = () => true,
} = {}) {
  if (!isCurrent()) return { skipped: 'edited' };
  if (!result || !result.deferred) return { skipped: 'not_deferred' };
  const messageId = result.messageId || null;

  const facts = localFacts({
    decision: result.decision,
    heuristic: result.heuristic,
    savedContact: result.savedContact,
    pushName: result.pushName,
    digits: result.formattedNumber,
  });
  const explained = await explainSuspicion({
    messages: result.reviewMessages,
    maskClient,
    llmOptions: llmReview,
    env,
  });
  const card = buildReviewCard({ facts, guide: explained.guide });

  return exclusive(() => deliverGuidedCard({
    result, queue, delivery, messageId, explained, card, forward, sendText, sendPoll, isCurrent,
  }));
}

async function deliverGuidedCard({
  result, queue, delivery, messageId, explained, card, forward, sendText, sendPoll, isCurrent,
}) {
  if (!isCurrent()) return { skipped: 'edited' };
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
  if (!isCurrent()) return { skipped: 'edited' };
  if (typeof sendText === 'function') {
    try {
      await sendText(card);
    } catch (err) {
      const cardError = err && err.message ? err.message : String(err);
      forwardError = forwardError || cardError;
    }
  }

  let pollId = null;
  if (!isCurrent()) return { skipped: 'edited' };
  if (typeof sendPoll === 'function') {
    try {
      pollId = messageIdOf(await sendPoll(REVIEW_POLL_NAME, optionLabels(REVIEW_OPTIONS)));
    } catch (err) {
      pollId = null;
      forwardError = forwardError || (err && err.message ? err.message : String(err));
    }
  }
  if (!pollId && isCurrent() && typeof sendText === 'function') {
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
    label: result.scoreResult && result.scoreResult.label,
    archiveReason: decision.archiveReason || null,
    blockReason: decision.blockReason || null,
    heuristicId: (result.heuristic && result.heuristic.id) || decision.heuristicId || null,
    contactName: reviewContactName(result),
    proposedAction: decision.action,
    createdAt: new Date().toISOString(),
    ...delivery,
    resolved: !isCurrent(),
    ...(!isCurrent() ? { voidReason: 'edited', resolvedAt: new Date().toISOString() } : {}),
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
  invalidatePendingGuidedReview,
};
