'use strict';

const {
  parseReviewChoice,
  parseSetupChoice,
  parseUnblockChoice,
  parseMoneyWarnChoice,
} = require('./review-prompt');

const RECONFIGURE_COMMAND = '設定';

function serializedId(id) {
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id._serialized === 'string') return id._serialized;
  return null;
}

function messageIdOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return serializedId(value.id) || serializedId(value.pollId) || serializedId(value);
}

function parentIdFromVote(vote) {
  if (!vote) return null;
  const parent = vote.parentMessage || vote.parentMsg || null;
  return (
    serializedId(parent && parent.id) ||
    serializedId(vote.parentMsgKey) ||
    (typeof vote.parentMessageId === 'string' ? vote.parentMessageId : null)
  );
}

function selectedVoteNames(vote) {
  const options = vote && vote.selectedOptions;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === 'string') return option;
      return option && option.name ? String(option.name) : '';
    })
    .filter(Boolean);
}

function routeSelfText({ body, quotedId, operator, queue } = {}) {
  const text = String(body || '').trim();
  if (text === RECONFIGURE_COMMAND) return { kind: 'reconfigure' };
  if (!quotedId) return { kind: 'ignore' };
  if (operator && typeof operator.isSetupPoll === 'function' && operator.isSetupPoll(quotedId)) {
    const mode = parseSetupChoice(text);
    return mode ? { kind: 'setup', mode } : { kind: 'ignore' };
  }
  if (!queue || typeof queue.get !== 'function') return { kind: 'ignore' };
  const item = queue.get(quotedId);
  if (!item) return { kind: 'ignore' };
  if (item.kind === 'unblock') {
    const choice = parseUnblockChoice(text);
    if (!choice) return { kind: 'ignore' };
    if (item.resolved) return { kind: 'already', pollId: quotedId };
    return { kind: 'unblock', choice, pollId: quotedId };
  }
  if (item.kind === 'money_warn') {
    const choice = parseMoneyWarnChoice(text);
    if (!choice) return { kind: 'ignore' };
    if (item.resolved) return { kind: 'already', pollId: quotedId };
    return { kind: 'money_warn', choice, pollId: quotedId };
  }
  const choice = parseReviewChoice(text);
  if (!choice) return { kind: 'ignore' };
  if (item.resolved) return { kind: 'already', pollId: quotedId };
  return { kind: 'review', choice, pollId: quotedId };
}

function routeVote(vote, { operator, queue } = {}) {
  const names = selectedVoteNames(vote);
  if (names.length !== 1) return { kind: 'ignore' };
  const pollId = parentIdFromVote(vote);
  if (!pollId) return { kind: 'ignore' };
  if (operator && typeof operator.isSetupPoll === 'function' && operator.isSetupPoll(pollId)) {
    const mode = parseSetupChoice(names[0]);
    return mode ? { kind: 'setup', mode, pollId } : { kind: 'ignore' };
  }
  if (!queue || typeof queue.get !== 'function' || !queue.get(pollId)) return { kind: 'ignore' };
  const item = queue.get(pollId);
  if (item && item.kind === 'unblock') {
    const choice = parseUnblockChoice(names[0]);
    if (!choice) return { kind: 'ignore' };
    if (item.resolved) return { kind: 'already', pollId };
    return { kind: 'unblock', choice, pollId };
  }
  if (item && item.kind === 'money_warn') {
    const choice = parseMoneyWarnChoice(names[0]);
    if (!choice) return { kind: 'ignore' };
    if (item.resolved) return { kind: 'already', pollId };
    return { kind: 'money_warn', choice, pollId };
  }
  const choice = parseReviewChoice(names[0]);
  if (!choice) return { kind: 'ignore' };
  if (item && item.resolved) return { kind: 'already', pollId };
  return { kind: 'review', choice, pollId };
}

module.exports = {
  RECONFIGURE_COMMAND,
  serializedId,
  messageIdOf,
  parentIdFromVote,
  selectedVoteNames,
  routeSelfText,
  routeVote,
};
