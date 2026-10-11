'use strict';

const { HEURISTIC_CONTACT_LABELS } = require('./block-policy');
const { ARCHIVE_REASON_LINES, GUIDE_UNAVAILABLE } = require('./review-prompt');
const { explainSuspicion } = require('./review-guide');

const PHONE_UNRESOLVED = '電話未解析到';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function textOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

/**
 * Name shown in the chat list before a block renames the contact to 封鎖·…
 * Saved contacts use the address-book name. Everyone else uses the push name.
 */
function chatListName(contact, msg) {
  const savedName = textOf(contact && contact.name);
  const push =
    textOf(msg && msg._data && msg._data.notifyName) || textOf(contact && contact.pushname);
  if (contact && contact.isMyContact && savedName) return savedName;
  return push || savedName || '';
}

function headline(action, blocked, archived) {
  const archiveFailed = archived === false;
  if (action === 'archive') return archiveFailed ? '封存未完成' : '已封存，未封鎖';
  if (action === 'block') {
    if (blocked === false && archiveFailed) return '封鎖未完成，封存未完成';
    if (blocked === false) return '封鎖未完成，對話已嘗試封存';
    if (archiveFailed) return '已封鎖，封存未完成';
    return '已封鎖並封存';
  }
  return '';
}

function buildActionNotice({
  action,
  blocked = true,
  archived,
  listName,
  digits,
  score,
  scoreResult,
  thresholds,
  heuristicId,
  heuristic,
  archiveReason,
  decision,
  rubric,
  includeGuide = false,
  guide = null,
} = {}) {
  const act = action || (decision && decision.action) || '';
  const title = headline(act, blocked, archived);
  if (!title) return '';

  const lines = [title];
  const name = textOf(listName);
  lines.push(name ? `左邊：${name}` : '左邊：未知');
  const phone = textOf(digits);
  lines.push(phone ? `電話：${phone}` : PHONE_UNRESOLVED);

  const scoreValue = finite(score != null ? score : scoreResult && scoreResult.score);
  const thresholdSource =
    thresholds ||
    (scoreResult && scoreResult.thresholds) ||
    (rubric && rubric.thresholds) ||
    {};
  const archive = finite(thresholdSource.archive);
  if (scoreValue != null) {
    lines.push(
      `分數 ${Math.round(scoreValue)}（封存線 ${Math.round(archive == null ? 42 : archive)}）`,
    );
  }

  const heuristicKey =
    (heuristic && heuristic.hit && heuristic.id) ||
    heuristicId ||
    (decision && decision.heuristicId) ||
    null;
  const heuristicLabel = heuristicKey && HEURISTIC_CONTACT_LABELS[heuristicKey];
  if (heuristicLabel) lines.push(`句式：${heuristicLabel}`);

  const reason = archiveReason || (decision && decision.archiveReason) || null;
  if (reason && reason !== 'obvious_scam') {
    lines.push(ARCHIVE_REASON_LINES[reason] || `原因：${reason}`);
  }

  if (includeGuide) {
    lines.push('');
    lines.push(guide ? `模型講解：\n${guide}` : `模型講解：\n${GUIDE_UNAVAILABLE}`);
  }
  return lines.join('\n');
}

/**
 * Ask for a Cantonese note from the masked transcript only, then attach the
 * chat-list name and phone on this machine. Those two fields are not arguments
 * to the mask call or the chat API.
 */
async function composeActionNotice({
  messages,
  scoreClient,
  llmOptions,
  env,
  ...identity
} = {}) {
  const list = Array.isArray(messages)
    ? messages.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  let guide = null;
  if (list.length) {
    const explained = await explainSuspicion({
      messages: list,
      scoreClient,
      llmOptions,
      env,
    });
    guide = explained && explained.guide ? explained.guide : null;
  }
  return {
    text: buildActionNotice({ ...identity, includeGuide: true, guide, env }),
    guide,
  };
}

module.exports = {
  PHONE_UNRESOLVED,
  chatListName,
  buildActionNotice,
  composeActionNotice,
};
