'use strict';

require('../scripts/block-log-test-setup');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createReviewQueue } = require('./review-queue');
const { parseUnblockChoice } = require('./review-prompt');
const { routeSelfText, routeVote } = require('./self-chat');
const { applyUnblockChoice } = require('./apply-review-choice');
const { unblockContact } = require('./wa-actions');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-poll-'));
}

describe('unblock poll routing', () => {
  it('maps unblock poll labels and routes votes separately from guided review', () => {
    assert.equal(parseUnblockChoice('解除封鎖'), 'unblock');
    assert.equal(parseUnblockChoice('解封', { loose: true }), 'unblock');
    assert.equal(parseUnblockChoice('解风', { loose: true }), 'unblock');
    assert.equal(parseUnblockChoice('解疯', { loose: true }), 'unblock');
    assert.equal(parseUnblockChoice('保持', { loose: true }), 'keep');
    assert.equal(parseUnblockChoice('唔好解封', { loose: true }), 'keep');
    assert.equal(parseUnblockChoice('唔好解风', { loose: true }), 'keep');
    assert.equal(parseUnblockChoice('唔想解封', { loose: true }), 'keep');
    assert.equal(parseUnblockChoice('2'), 'keep');
    assert.equal(parseUnblockChoice('1. 唔好解封', { loose: true }), 'keep');
    assert.equal(parseUnblockChoice('2解封', { loose: true }), null);
    assert.equal(parseUnblockChoice('解封保持唔好解封', { loose: true }), null);
    assert.equal(parseUnblockChoice('我覺得解封好奇怪', { loose: true }), null);
    const queue = createReviewQueue({ filePath: path.join(tempDir(), 'q.json') });
    queue.add({ pollId: 'ub-1', kind: 'unblock', chatId: 'c1', resolved: false });
    queue.add({ pollId: 'rv-1', chatId: 'c2', resolved: false });
    assert.equal(routeSelfText({ body: '1', quotedId: 'ub-1', queue }).kind, 'unblock');
    assert.equal(routeSelfText({ body: '1', quotedId: 'rv-1', queue }).kind, 'review');
    assert.equal(
      routeVote(
        { selectedOptions: [{ name: '解除封鎖' }], parentMessage: { id: 'ub-1' } },
        { queue },
      ).kind,
      'unblock',
    );
  });

  it('calls unblockContact when the operator chooses 解除封鎖', async () => {
    let unblocked = false;
    const result = await applyUnblockChoice(
      { chatId: '85290000000@c.us', digits: '85290000000', contactName: '封鎖·惡意域名' },
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
          return { unblocked: true, clearedRename: true, unmuted: false, errors: [] };
        },
      },
    );
    assert.equal(unblocked, true);
    assert.match(result.text, /已解除封鎖/);
    assert.match(result.text, /仍然封存/);
  });

  it('clears a legacy poll name only when the fresh contact still matches it', async () => {
    const blockName = '封鎖·惡意域名';
    const queue = createReviewQueue({ filePath: path.join(tempDir(), 'q.json') });
    queue.add({
      kind: 'unblock',
      pollId: 'ub-legacy',
      chatId: '85290000000@c.us',
      digits: '85290000000',
      contactName: blockName,
      blockContactName: blockName,
    });
    const poll = queue.get('ub-legacy');
    const calls = [];
    const liveContact = {
      name: blockName,
      async unblock() {
        calls.push('unblock');
      },
    };
    const client = {
      async deleteAddressbookContact(phone) {
        calls.push(`delete:${phone}`);
      },
      async saveOrEditAddressbookContact() {
        calls.push('save');
      },
    };
    let freshContactFetched = false;
    const result = await applyUnblockChoice(poll, 'unblock', {
      getChat: async (chatId) => ({ id: { _serialized: chatId } }),
      getContact: async () => {
        freshContactFetched = true;
        return liveContact;
      },
      unblockContact: (args) =>
        unblockContact({ ...args, client, pause: async () => {} }),
    });

    assert.equal(freshContactFetched, true);
    assert.equal(result.clearedRename, true);
    assert.deepEqual(calls, ['unblock', 'delete:85290000000']);
  });

  it('keeps block without calling unblockContact', async () => {
    let called = false;
    const result = await applyUnblockChoice(
      { chatId: '85290000000@c.us', digits: '85290000000' },
      'keep',
      {
        unblockContact: async () => {
          called = true;
          return { unblocked: true };
        },
      },
    );
    assert.equal(called, false);
    assert.match(result.text, /保持封鎖/);
  });
});

describe('voiding guided polls on edit', () => {
  it('voids only the open review polls for that message and routes them as void', () => {
    const queue = createReviewQueue({ filePath: path.join(tempDir(), 'q.json') });
    queue.add({ pollId: 'rv-1', messageId: 'm1', chatId: 'c1', resolved: false });
    queue.add({ pollId: 'rv-2', messageId: 'm2', chatId: 'c2', resolved: false });
    queue.add({ pollId: 'ub-1', kind: 'unblock', messageId: 'm1', chatId: 'c1', resolved: false });

    const voided = queue.voidByMessageId('m1', 'edited');
    assert.deepEqual(voided.map((item) => item.pollId), ['rv-1']);
    assert.equal(queue.get('rv-1').resolved, true);
    assert.equal(queue.get('rv-2').resolved, false);
    assert.equal(queue.get('ub-1').resolved, false);
    assert.deepEqual(queue.voidByMessageId('m1', 'edited'), []);

    assert.equal(routeSelfText({ body: '2', quotedId: 'rv-1', queue }).kind, 'voided');
    assert.equal(
      routeVote(
        { selectedOptions: [{ name: '只封存' }], parentMessage: { id: 'rv-1' } },
        { queue },
      ).kind,
      'voided',
    );
  });
});
