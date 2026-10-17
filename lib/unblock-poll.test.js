'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createReviewQueue } = require('./review-queue');
const { parseUnblockChoice } = require('./review-prompt');
const { routeSelfText, routeVote } = require('./self-chat');
const { applyUnblockChoice } = require('./apply-review-choice');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-poll-'));
}

describe('unblock poll routing', () => {
  it('maps unblock poll labels and routes votes separately from guided review', () => {
    assert.equal(parseUnblockChoice('解除封鎖'), 'unblock');
    assert.equal(parseUnblockChoice('2'), 'keep');
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
