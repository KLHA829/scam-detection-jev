'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { blockAndRename, unblockContact } = require('./wa-actions');

describe('unblockContact', () => {
  it('unblocks, deletes an unsaved renamed contact, and unmutes when possible', async () => {
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
      async deleteAddressbookContact(phone) {
        calls.push(`delete:${phone}`);
      },
      async saveOrEditAddressbookContact() {
        calls.push('save');
      },
    };
    const out = await unblockContact({
      client,
      contact,
      chat,
      digits: '85290000000',
      renamed: true,
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.unblocked, true);
    assert.equal(out.clearedRename, true);
    assert.equal(out.unmuted, true);
    assert.deepEqual(calls, ['unblock', 'delete:85290000000', 'unmute']);
  });

  it('does not clear a saved contact name', async () => {
    let deleteCalls = 0;
    let saveCalls = 0;
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact() {
          deleteCalls += 1;
        },
        async saveOrEditAddressbookContact() {
          saveCalls += 1;
        },
      },
      contact: { async unblock() {} },
      digits: '85290000000',
      blockContactName: '封鎖·惡意域名',
      renamed: true,
      savedContact: true,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, false);
    assert.equal(deleteCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('does not clear when the contact was not renamed', async () => {
    let deleteCalls = 0;
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact() {
          deleteCalls += 1;
        },
      },
      contact: { async unblock() {} },
      digits: '85290000000',
      renamed: false,
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, false);
    assert.equal(deleteCalls, 0);
  });

  it('uses the known-unsaved fallback when rename status is absent', async () => {
    let deletedPhone = null;
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact(phone) {
          deletedPhone = phone;
        },
      },
      contact: { async unblock() {} },
      digits: '85290000000',
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, true);
    assert.equal(deletedPhone, '85290000000');
  });

  it('reports a missing delete API without saving a blank contact name', async () => {
    let saveCalls = 0;
    const out = await unblockContact({
      client: {
        async saveOrEditAddressbookContact() {
          saveCalls += 1;
        },
      },
      contact: { async unblock() {} },
      digits: '85290000000',
      renamed: true,
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, false);
    assert.deepEqual(out.errors, ['clear_rename:unavailable']);
    assert.equal(saveCalls, 0);
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
