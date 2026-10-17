'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendBlockRecord, readRecentBlockRecords } = require('./block-log');
const {
  parseOperatorCommand,
  shouldProcessSelfMessageBody,
  resolveUnblockTarget,
  formatRecentBlocksList,
} = require('./operator-commands');
const { createReviewQueue } = require('./review-queue');
const { applyUnblockChoice } = require('./apply-review-choice');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'operator-cmd-'));
}

describe('operator self-chat commands', () => {
  it('parses unblock, keep, list, and help commands', () => {
    assert.deepEqual(parseOperatorCommand('解除 91234567'), {
      kind: 'unblock',
      digits: '91234567',
    });
    assert.deepEqual(parseOperatorCommand('unblock 85291234567'), {
      kind: 'unblock',
      digits: '85291234567',
    });
    assert.deepEqual(parseOperatorCommand('解除'), { kind: 'unblock', digits: null });
    assert.deepEqual(parseOperatorCommand('保持'), { kind: 'keep_blocked' });
    assert.deepEqual(parseOperatorCommand('keep'), { kind: 'keep_blocked' });
    assert.deepEqual(parseOperatorCommand('最近封鎖'), { kind: 'list_blocks' });
    assert.deepEqual(parseOperatorCommand('blocks'), { kind: 'list_blocks' });
    assert.deepEqual(parseOperatorCommand('幫助'), { kind: 'help' });
    assert.equal(parseOperatorCommand('你好').kind, 'ignore');
  });

  it('accepts operator bodies without a quoted message', () => {
    assert.equal(shouldProcessSelfMessageBody('設定', false), true);
    assert.equal(shouldProcessSelfMessageBody('解除', false), true);
    assert.equal(shouldProcessSelfMessageBody('random', false), false);
    assert.equal(shouldProcessSelfMessageBody('random', true), true);
  });

  it('resolves unblock targets from polls and block log', () => {
    const queue = createReviewQueue({ filePath: path.join(tempDir(), 'q.json') });
    queue.add({
      pollId: 'ub-1',
      kind: 'unblock',
      chatId: '85291111111@c.us',
      digits: '85291111111',
      resolved: false,
      createdAt: '2026-10-17T10:00:00.000Z',
    });
    const open = queue.findOpenUnblock();
    assert.equal(open.length, 1);
    assert.deepEqual(resolveUnblockTarget(null, { openUnblockPolls: open, recentBlocks: [] }).kind, 'poll');

    const recent = [
      { chatId: '85292222222@c.us', digits: '85292222222', pushName: 'A', blocked: true },
    ];
    assert.equal(
      resolveUnblockTarget('92222222', { openUnblockPolls: [], recentBlocks: recent }).kind,
      'record',
    );
    const overlapLog = [
      { chatId: '85281111111@c.us', digits: '85281111111', pushName: 'B', blocked: true },
    ];
    assert.equal(
      resolveUnblockTarget('111111', { openUnblockPolls: open, recentBlocks: overlapLog }).kind,
      'ambiguous',
    );
  });

  it('reads recent block rows from jsonl', () => {
    const dir = tempDir();
    const file = path.join(dir, 'blocks.jsonl');
    appendBlockRecord({ chatId: '1', digits: '111', blocked: true, pushName: 'One' }, file);
    appendBlockRecord({ chatId: '2', digits: '222', blocked: false, pushName: 'Skip' }, file);
    appendBlockRecord({ chatId: '3', digits: '333', blocked: true, pushName: 'Three' }, file);
    const rows = readRecentBlockRecords(5, file);
    assert.equal(rows.length, 3);
    assert.match(formatRecentBlocksList(rows, { limit: 5 }), /Three · 333/);
    assert.doesNotMatch(formatRecentBlocksList(rows, { limit: 5 }), /Skip/);
  });

  it('calls unblockContact for a direct operator unblock record', async () => {
    let unblocked = false;
    const result = await applyUnblockChoice(
      {
        chatId: '85293333333@c.us',
        digits: '85293333333',
        blockContactName: '封鎖·測試',
      },
      'unblock',
      {
        getChat: async () => ({
          async getContact() {
            return { unblock: async () => {} };
          },
        }),
        getContact: async (chat) => chat.getContact(),
        unblockContact: async () => {
          unblocked = true;
          return { unblocked: true, clearedRename: true, errors: [] };
        },
      },
    );
    assert.equal(unblocked, true);
    assert.match(result.text, /仍然封存/);
  });
});
