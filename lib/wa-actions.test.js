'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { blockAndRename, unblockContact } = require('./wa-actions');

describe('unblockContact', () => {
  it('unblocks, clears the block rename, and unmutes when possible', async () => {
    const calls = [];
    const contact = {
      async unblock() {
        calls.push('unblock');
      },
    };
    const chat = {
      async unmute() {
        calls.push('unmute');
      },
    };
    const client = {
      async saveOrEditAddressbookContact(phone, name) {
        calls.push(`rename:${phone}:${name}`);
      },
    };
    const out = await unblockContact({
      client,
      contact,
      chat,
      digits: '85290000000',
      blockContactName: '封鎖·惡意域名',
      pause: async () => {},
    });
    assert.equal(out.unblocked, true);
    assert.equal(out.clearedRename, true);
    assert.equal(out.unmuted, true);
    assert.deepEqual(calls, ['unblock', 'rename:85290000000:', 'unmute']);
  });
});

describe('blockAndRename', () => {
  it('still blocks when rename is skipped', async () => {
    const contact = {
      async block() {},
    };
    const out = await blockAndRename({ contact, chat: null, digits: null, contactName: null });
    assert.equal(out.blocked, true);
  });
});
