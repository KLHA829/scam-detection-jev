'use strict';

const { appendBlockRecord, defaultBlockLogPath } = require('./block-log');

function confirmation(choice, result) {
  if (choice === 'leave') return '已留低，冇封存亦冇封鎖。';
  if (choice === 'archive') return '已封存，未封鎖。';
  if (choice === 'block') {
    if (result && result.blocked) return '已封鎖並封存。';
    return '封鎖未完成，對話已嘗試封存。';
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
      return { ok: true, action: 'archive', text: confirmation('archive') };
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
      text: confirmation('block', { blocked: Boolean(blockResult && blockResult.blocked) }),
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

module.exports = {
  confirmation,
  applyReviewChoice,
};
