'use strict';

const { appendBlockRecord, defaultBlockLogPath } = require('./block-log');
const { buildActionNotice } = require('./action-notice');

function confirmation(choice, result, record) {
  if (choice === 'leave') return '已留低，冇封存亦冇封鎖。';
  if (choice === 'archive' || choice === 'block') {
    return buildActionNotice({
      action: choice,
      blocked: Boolean(result && result.blocked),
      archived: !(result && result.archived === false),
      listName: record && (record.listName || record.pushName),
      digits: record && record.digits,
      heuristicId: record && record.heuristicId,
      archiveReason: record && record.archiveReason,
    });
  }
  return '已經處理咗。';
}

async function applyReviewChoice(record, choice, deps = {}) {
  if (!record) return { ok: false, action: null, text: '搵唔到呢條待處理訊息。' };
  if (choice === 'leave') return { ok: true, action: 'leave', text: confirmation('leave') };
  if (choice !== 'archive' && choice !== 'block') {
    return { ok: false, action: null, text: '睇唔明呢個選擇。' };
  }
  if (typeof deps.getChat !== 'function') {
    return { ok: false, action: choice, text: '而家攞唔到個對話。' };
  }

  const run = async () => {
    const chat = await deps.getChat(record.chatId);
    if (choice === 'archive') {
      if (typeof deps.pause === 'function') await deps.pause();
      await deps.archiveChat(chat, record);
      return { ok: true, action: 'archive', text: confirmation('archive', null, record) };
    }

    const contact = typeof deps.getContact === 'function' ? await deps.getContact(chat, record) : null;
    const blockResult = await deps.blockContact({
      chat,
      contact,
      record,
      contactName: record.savedContact ? null : record.contactName,
    });
    let archived = false;
    let archiveError = null;
    try {
      if (typeof deps.pause === 'function') await deps.pause();
      await deps.archiveChat(chat, record);
      archived = true;
    } catch (err) {
      archiveError = err && err.message ? err.message : String(err);
    }
    const logRecord = {
      at: new Date().toISOString(),
      source: 'operator',
      chatId: record.chatId,
      digits: record.digits || null,
      pushName: record.pushName || null,
      score: record.score,
      label: record.label || null,
      archiveReason: record.archiveReason || null,
      blockReason: record.blockReason || 'operator',
      heuristicId: record.heuristicId || null,
      contactName: record.savedContact ? null : record.contactName || null,
      savedContact: Boolean(record.savedContact),
      renamed: Boolean(blockResult && blockResult.renamed),
      blocked: Boolean(blockResult && blockResult.blocked),
      muted: Boolean(blockResult && blockResult.muted),
      archived,
      errors: [
        ...((blockResult && blockResult.errors) || []),
        ...(archiveError ? [`archive:${archiveError}`] : []),
      ],
    };
    let logError = null;
    try {
      if (typeof deps.recordBlock === 'function') await deps.recordBlock(logRecord);
      else appendBlockRecord(logRecord, defaultBlockLogPath(deps.env));
    } catch (err) {
      logError = err && err.message ? err.message : String(err);
      if (!(blockResult && blockResult.blocked)) throw err;
    }
    return {
      ok: Boolean(blockResult && blockResult.blocked),
      action: 'block',
      blocked: Boolean(blockResult && blockResult.blocked),
      renamed: Boolean(blockResult && blockResult.renamed),
      savedContact: record.savedContact,
      text: confirmation(
        'block',
        { blocked: Boolean(blockResult && blockResult.blocked), archived },
        record,
      ),
      archiveError,
      ...(logError ? { logError } : {}),
    };
  };

  try {
    if (typeof deps.exclusive === 'function') return await deps.exclusive(run);
    return await run();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, action: choice, text: `做唔到：${message}` };
  }
}

function unblockConfirmation(result) {
  if (result && result.unblocked) {
    return '已解除封鎖。對話可能仍然封存，你可以喺 WhatsApp 自己打開。';
  }
  return '保持封鎖。';
}

async function applyUnblockChoice(record, choice, deps = {}) {
  if (!record) return { ok: false, action: null, text: '搵唔到呢條待處理訊息。' };
  if (choice === 'keep') {
    return { ok: true, action: 'keep', text: unblockConfirmation({ unblocked: false }) };
  }
  if (choice !== 'unblock') {
    return { ok: false, action: null, text: '睇唔明呢個選擇。' };
  }
  if (typeof deps.getChat !== 'function') {
    return { ok: false, action: 'unblock', text: '而家攞唔到個對話。' };
  }

  const run = async () => {
    const chat = await deps.getChat(record.chatId);
    const contact =
      typeof deps.getContact === 'function' ? await deps.getContact(chat, record) : null;
    if (typeof deps.unblockContact !== 'function') {
      return { ok: false, action: 'unblock', text: '而家解除唔到封鎖。' };
    }
    const unblockResult = await deps.unblockContact({
      chat,
      contact,
      record,
      digits: record.digits,
      blockContactName: record.blockContactName || record.contactName,
      renamed: record.renamed,
      savedContact: record.savedContact,
    });
    return {
      ok: Boolean(unblockResult && unblockResult.unblocked),
      action: 'unblock',
      text: unblockConfirmation(unblockResult),
      ...unblockResult,
    };
  };

  try {
    if (typeof deps.exclusive === 'function') return await deps.exclusive(run);
    return await run();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, action: 'unblock', text: `做唔到：${message}` };
  }
}

module.exports = {
  confirmation,
  applyReviewChoice,
  unblockConfirmation,
  applyUnblockChoice,
};
