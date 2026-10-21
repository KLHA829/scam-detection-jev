'use strict';

const { messageIdOf } = require('./self-chat');
const { buildMoneyWarnNotice } = require('./money-warn');
const { MONEY_WARN_POLL_NAME, optionLabels, MONEY_WARN_OPTIONS } = require('./review-prompt');

async function deliverMoneyWarn({
  result,
  queue,
  sendText,
  sendPoll,
  listName,
} = {}) {
  const warn = result && result.moneyWarn;
  if (!warn || !warn.shouldWarn) return { delivered: false };
  if (!queue || typeof queue.add !== 'function') {
    throw new Error('review queue required for money warn');
  }
  if (typeof sendText !== 'function' || typeof sendPoll !== 'function') {
    return { delivered: false, error: 'send hooks missing' };
  }

  const notice = buildMoneyWarnNotice({
    listName,
    digits: result.formattedNumber,
    kind: warn.kind,
    elevated: warn.elevated,
  });
  await sendText(notice);
  const sent = await sendPoll(MONEY_WARN_POLL_NAME, optionLabels(MONEY_WARN_OPTIONS));
  const pollId = messageIdOf(sent);
  if (!pollId) return { delivered: true, pollId: null };
  queue.add({
    kind: 'money_warn',
    pollId,
    chatId: result.chatId,
    messageId: result.messageId || null,
    digits: result.formattedNumber || null,
    listName: listName || null,
    warnKind: warn.kind,
    createdAt: new Date().toISOString(),
    resolved: false,
  });
  return { delivered: true, pollId };
}

module.exports = {
  deliverMoneyWarn,
};
