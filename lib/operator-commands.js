// @ts-check
'use strict';

const { defaultBlockLogPath, readRecentBlockRecords } = require('./block-log');

const OPERATOR_HELP_TEXT = [
  '自我對話指令（只喺呢個 chat 有效）：',
  '解除 [號碼] — 解除封鎖（唔會取消封存）',
  '解除 — 最近待決定或最近封鎖紀錄',
  '保持 / keep — 有待決定嘅解除問題時保持封鎖',
  '最近封鎖 / blocks — 列出最近封鎖',
  '幫助 / help — 顯示呢段說明',
  '設定 — 改處理模式（問卷，唔係文字設定）',
  '語音 — 開咗 VOICE_COMMANDS_ENABLED 之後，可以喺呢度用廣東話 voice note 講封佢／唔好封／解封／保持',
].join('\n');

function normalizeDigits(value) {
  return value == null ? '' : String(value).replace(/\D/g, '');
}

function digitsMatch(stored, query) {
  const s = normalizeDigits(stored);
  const q = normalizeDigits(query);
  if (!q || !s) return false;
  return s === q || s.endsWith(q) || q.endsWith(s);
}

function blockDisplayName(record) {
  if (!record) return null;
  return record.listName || record.pushName || record.contactName || null;
}

function formatBlockLine(index, record) {
  const name = blockDisplayName(record) || '（無名）';
  const digits = normalizeDigits(record.digits) || record.chatId || '—';
  return `${index}. ${name} · ${digits}`;
}

function parseOperatorCommand(body) {
  const text = String(body || '').trim();
  if (!text) return { kind: 'ignore' };
  const compact = text.replace(/\s+/g, '');
  if (/^(幫助|帮助|help)$/i.test(compact)) return { kind: 'help' };
  if (/^(最近封鎖|最近封锁|blocks)$/i.test(compact)) return { kind: 'list_blocks' };
  if (/^(保持|保持封鎖|保持封锁|繼續封鎖|继续封鎖|唔好解(?:封|風|风)|唔使解(?:封|風|风)|唔想解(?:封|風|风)|keep)$/i.test(compact)) {
    return { kind: 'keep_blocked' };
  }
  const unblockMatch = compact.match(/^(?:幫我|帮我)?(?:解除封鎖|解除封锁|解(?:封|風|风)|解除|unblock)(?:\s*(.+))?$/i);
  if (unblockMatch) {
    const rest = (unblockMatch[1] || '').trim();
    if (!rest) return { kind: 'unblock', digits: null };
    const digits = normalizeDigits(rest);
    if (!digits) return { kind: 'ignore' };
    return { kind: 'unblock', digits };
  }
  return { kind: 'ignore' };
}

function shouldProcessSelfMessageBody(body, hasQuotedMsg) {
  const text = String(body || '').trim();
  if (text === '設定') return true;
  if (hasQuotedMsg) return true;
  return parseOperatorCommand(text).kind !== 'ignore';
}

function resolveUnblockCommand(digits, { env = process.env, openUnblockPolls = [] } = {}) {
  const recentBlocks = loadRecentBlocksForCommands(env, normalizeDigits(digits) ? Infinity : 20);
  return resolveUnblockTarget(digits, { openUnblockPolls, recentBlocks });
}

function resolveUnblockTarget(digits, { openUnblockPolls = [], recentBlocks = [] } = {}) {
  recentBlocks = activeBlockRecords(recentBlocks);
  const query = normalizeDigits(digits);

  if (!query) {
    const open = openUnblockPolls.filter((row) => row && row.chatId);
    if (open.length === 1) {
      return { kind: 'poll', pollId: open[0].pollId, record: open[0] };
    }
    if (open.length > 1) {
      return { kind: 'ambiguous', candidates: open.map(pollRowToCandidate) };
    }
    const blocked = recentBlocks.filter((row) => row && row.blocked !== false && row.chatId);
    if (blocked.length === 0) return { kind: 'not_found' };
    const latest = blocked[blocked.length - 1];
    return { kind: 'record', record: logRowToRecord(latest) };
  }

  const matches = [];
  const seen = new Set();
  const exactKeys = new Set([...openUnblockPolls, ...recentBlocks]
    .filter((row) => row && normalizeDigits(row.digits) === query)
    .map((row) => row.chatId || row.pollId)
    .filter(Boolean));
  function addCandidate(candidate) {
    const key = candidate.chatId || candidate.pollId;
    if (exactKeys.size > 0 && !exactKeys.has(key)) return;
    if (!key || seen.has(key)) return;
    seen.add(key);
    matches.push(candidate);
  }

  for (const poll of openUnblockPolls) {
    if (poll && digitsMatch(poll.digits, query)) {
      addCandidate({
        source: 'poll',
        pollId: poll.pollId,
        chatId: poll.chatId,
        digits: poll.digits,
        contactName: poll.contactName,
        blockContactName: poll.blockContactName,
        renamed: poll.renamed,
        savedContact: poll.savedContact,
        listName: poll.listName,
        displayName: blockDisplayName(poll),
      });
    }
  }

  for (const row of [...recentBlocks].reverse()) {
    if (!row || row.blocked === false || !row.chatId) continue;
    if (!digitsMatch(row.digits, query)) continue;
    addCandidate({
      source: 'log',
      chatId: row.chatId,
      digits: row.digits,
      contactName: row.contactName,
      blockContactName: row.blockContactName || row.contactName,
      renamed: row.renamed,
      savedContact: row.savedContact,
      listName: row.pushName,
      displayName: blockDisplayName(row),
    });
  }

  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length === 1) {
    const only = matches[0];
    if (only.source === 'poll') {
      return { kind: 'poll', pollId: only.pollId, record: only };
    }
    return { kind: 'record', record: logRowToRecord(only) };
  }
  return { kind: 'ambiguous', candidates: matches };
}

function pollRowToCandidate(poll) {
  return {
    source: 'poll',
    pollId: poll.pollId,
    chatId: poll.chatId,
    digits: poll.digits,
    blockContactName: poll.blockContactName || poll.contactName,
    renamed: poll.renamed,
    savedContact: poll.savedContact,
    displayName: blockDisplayName(poll),
  };
}

function logRowToRecord(row) {
  return {
    chatId: row.chatId,
    digits: row.digits,
    contactName: row.contactName,
    blockContactName: row.blockContactName || row.contactName,
    renamed: row.renamed,
    savedContact: row.savedContact,
    listName: row.pushName || row.listName,
  };
}

function formatRecentBlocksList(records, { limit = 5 } = {}) {
  const blocked = activeBlockRecords(records);
  const slice = blocked.slice(-limit);
  if (slice.length === 0) return '最近冇封鎖紀錄。';
  const lines = slice.map((row, index) => formatBlockLine(index + 1, row));
  return ['最近封鎖：', ...lines].join('\n');
}

function formatAmbiguousUnblock(candidates) {
  const lines = candidates.map((row, index) => {
    const name = row.displayName || blockDisplayName(row) || '（無名）';
    const digits = normalizeDigits(row.digits) || row.chatId || '—';
    return `${index + 1}. ${name} · ${digits}`;
  });
  return ['有多個符合，請打「解除 全號碼」：', ...lines].join('\n');
}

function formatAmbiguousKeepBlocked(candidates) {
  const lines = candidates.map((row, index) => {
    const name = row.displayName || blockDisplayName(row) || '（無名）';
    const digits = normalizeDigits(row.digits) || row.chatId || '—';
    return `${index + 1}. ${name} · ${digits}`;
  });
  return ['有多個待決定嘅解除封鎖問題，請喺想保持封鎖嗰個投票揀「保持封鎖」：', ...lines].join('\n');
}

function loadRecentBlocksForCommands(env = process.env, limit = 20) {
  const max = Math.max(1, Number(limit) || 20);
  return activeBlockRecords(readRecentBlockRecords(Infinity, defaultBlockLogPath(env))).slice(-max);
}

function activeBlockRecords(records) {
  const unblocked = new Set();
  return [...records].reverse().filter((row) => {
    if (!row) return false;
    if (row.unblocked === true) {
      unblocked.add(row.chatId);
      return false;
    }
    return row.blocked !== false && !unblocked.has(row.chatId);
  }).reverse();
}

module.exports = {
  OPERATOR_HELP_TEXT,
  parseOperatorCommand,
  shouldProcessSelfMessageBody,
  resolveUnblockTarget,
  resolveUnblockCommand,
  formatRecentBlocksList,
  formatAmbiguousUnblock,
  formatAmbiguousKeepBlocked,
  loadRecentBlocksForCommands,
  digitsMatch,
};
