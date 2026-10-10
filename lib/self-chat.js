'use strict';

const { parseReviewChoice, parseSetupChoice } = require('./review-prompt');

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
  const choice = parseReviewChoice(names[0]);
  if (!choice) return { kind: 'ignore' };
  const item = queue.get(pollId);
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
