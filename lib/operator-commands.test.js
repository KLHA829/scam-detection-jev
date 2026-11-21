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
  loadRecentBlocksForCommands,
} = require('./operator-commands');
const { createReviewQueue } = require('./review-queue');
const { applyUnblockChoice } = require('./apply-review-choice');
const { unblockContact } = require('./wa-actions');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'operator-cmd-'));
}

describe('operator self-chat commands', () => {
  it('uses the newest successful reblock metadata while preserving open poll priority', () => {
    const file = path.join(tempDir(), 'blocks.jsonl');
    const old = {
      chatId: '85291111111@c.us', digits: '85291111111', blocked: true,
      contactName: 'old name', renamed: false, savedContact: false,
    };
    const latest = { ...old, contactName: 'new name', renamed: true };
    appendBlockRecord(old, file);
    appendBlockRecord(latest, file);
    appendBlockRecord({ ...old, contactName: 'failed name', blocked: false }, file);
    const recentBlocks = loadRecentBlocksForCommands({ BLOCK_LOG_PATH: file });
    const target = resolveUnblockTarget('91111111', { recentBlocks });
    assert.equal(target.kind, 'record');
    assert.equal(target.record.blockContactName, 'new name');
    assert.equal(target.record.renamed, true);
    assert.equal(recentBlocks[0].contactName, 'old name');
    const poll = { ...old, pollId: 'open-1', blockContactName: 'poll name' };
    const pending = resolveUnblockTarget('91111111', { recentBlocks, openUnblockPolls: [poll] });
    assert.equal(pending.kind, 'poll');
    assert.equal(pending.record.blockContactName, 'poll name');
  });

  it('limits successful block history only after filtering failed attempts', () => {
    const file = path.join(tempDir(), 'blocks.jsonl');
    const env = { BLOCK_LOG_PATH: file };
    assert.deepEqual(loadRecentBlocksForCommands(env), []);
    appendBlockRecord({ chatId: 'old@c.us', digits: '91111111', blocked: true }, file);
    appendBlockRecord({ chatId: 'new@c.us', digits: '92222222', blocked: true }, file);
    for (let i = 0; i < 20; i += 1) {
      appendBlockRecord({ chatId: 'failed@c.us', digits: '93333333', blocked: false }, file);
    }
    fs.appendFileSync(file, 'corrupt json\n');
    const rows = loadRecentBlocksForCommands(env);
    assert.equal(rows.length, 2);
    assert.equal(resolveUnblockTarget('91111111', { recentBlocks: rows }).kind, 'record');
    assert.equal(resolveUnblockTarget('93333333', { recentBlocks: rows }).kind, 'not_found');
    assert.deepEqual(loadRecentBlocksForCommands(env, 1).map((row) => row.chatId), ['new@c.us']);
  });

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
    let passed;
    const result = await applyUnblockChoice(
      {
        chatId: '85293333333@c.us',
        digits: '85293333333',
        contactName: '封鎖·測試',
        blockContactName: '封鎖·測試',
        renamed: true,
        savedContact: false,
      },
      'unblock',
      {
        getChat: async () => ({
          async getContact() {
            return { unblock: async () => {} };
          },
        }),
        getContact: async (chat) => chat.getContact(),
        unblockContact: async (record) => {
          passed = record;
          unblocked = true;
          return { unblocked: true, clearedRename: true, errors: [] };
        },
      },
    );
    assert.equal(unblocked, true);
    assert.equal(passed.renamed, true);
    assert.equal(passed.savedContact, false);
    assert.match(result.text, /仍然封存/);
  });

  it('preserves rename metadata from unblock queue and block-log candidates', async () => {
    const pollTarget = resolveUnblockTarget('91111111', {
      openUnblockPolls: [
        {
          pollId: 'ub-meta',
          chatId: '85291111111@c.us',
          digits: '85291111111',
          contactName: '封鎖·Poll',
          blockContactName: '封鎖·Poll',
          renamed: true,
          savedContact: false,
        },
      ],
      recentBlocks: [],
    });
    const logTarget = resolveUnblockTarget('92222222', {
      openUnblockPolls: [],
      recentBlocks: [
        {
          chatId: '85292222222@c.us',
          digits: '85292222222',
          contactName: 'Original Name',
          blockContactName: '封鎖·Log',
          renamed: false,
          savedContact: true,
          blocked: true,
        },
      ],
    });
    assert.equal(pollTarget.kind, 'poll');
    assert.equal(logTarget.kind, 'record');

    const received = [];
    for (const record of [pollTarget.record, logTarget.record]) {
      await applyUnblockChoice(record, 'unblock', {
        getChat: async () => ({}),
        unblockContact: async (unblockRecord) => {
          received.push({
            blockContactName: unblockRecord.blockContactName,
            renamed: unblockRecord.renamed,
            savedContact: unblockRecord.savedContact,
          });
          return { unblocked: true };
        },
      });
    }
    assert.deepEqual(received, [
      { blockContactName: '封鎖·Poll', renamed: true, savedContact: false },
      { blockContactName: '封鎖·Log', renamed: false, savedContact: true },
    ]);

    const ambiguousPolls = resolveUnblockTarget(null, {
      openUnblockPolls: [
        {
          pollId: 'ub-a',
          chatId: 'a@c.us',
          contactName: '封鎖·A',
        },
        {
          pollId: 'ub-b',
          chatId: 'b@c.us',
          contactName: '封鎖·B',
        },
      ],
      recentBlocks: [],
    });
    assert.equal(ambiguousPolls.candidates[0].blockContactName, '封鎖·A');
  });

  it('unblocks a legacy poll row using the fresh contact name', async () => {
    const blockName = '封鎖·惡意域名';
    const target = resolveUnblockTarget(null, {
      openUnblockPolls: [
        {
          kind: 'unblock',
          pollId: 'ub-legacy',
          chatId: '85293333333@c.us',
          digits: '85293333333',
          contactName: blockName,
          blockContactName: blockName,
        },
      ],
      recentBlocks: [],
    });
    const calls = [];
    const contact = {
      name: blockName,
      async unblock() {
        calls.push('unblock');
      },
    };
    const result = await applyUnblockChoice(target.record, 'unblock', {
      getChat: async () => ({}),
      getContact: async () => contact,
      unblockContact: (args) =>
        unblockContact({
          ...args,
          client: {
            async deleteAddressbookContact(phone) {
              calls.push(`delete:${phone}`);
            },
          },
          pause: async () => {},
        }),
    });

    assert.equal(result.clearedRename, true);
    assert.deepEqual(calls, ['unblock', 'delete:85293333333']);
  });
});
