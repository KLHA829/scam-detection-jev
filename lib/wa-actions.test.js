'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { blockAndRename, labelUnsavedContact, unblockContact } = require('./wa-actions');

const BLOCK_CONTACT_NAME = '封鎖·惡意域名';

describe('unblockContact', () => {
  it('unblocks, deletes an unsaved renamed contact, and unmutes when possible', async () => {
    const calls = [];
    const contact = {
      name: BLOCK_CONTACT_NAME,
      async unblock() {
        calls.push('unblock');
      },
    };
    const chat = {
      async getContact() {
        return { name: BLOCK_CONTACT_NAME };
      },
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
      blockContactName: BLOCK_CONTACT_NAME,
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
      contact: { name: BLOCK_CONTACT_NAME, async unblock() {} },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
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
      contact: { name: BLOCK_CONTACT_NAME, async unblock() {} },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
      renamed: false,
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, false);
    assert.equal(deleteCalls, 0);
  });

  it('clears a matching legacy block name when metadata is absent', async () => {
    let deletedPhone = null;
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact(phone) {
          deletedPhone = phone;
        },
      },
      contact: { name: BLOCK_CONTACT_NAME, async unblock() {} },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, true);
    assert.equal(deletedPhone, '85290000000');
  });

  it('does not delete an entry whose live name was edited', async () => {
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
      contact: { name: 'Alice Chan', async unblock() {} },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
      renamed: true,
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.unblocked, true);
    assert.equal(out.clearedRename, false);
    assert.equal(out.clearRenameSkipped, 'name_mismatch');
    assert.deepEqual(out.errors, []);
    assert.equal(deleteCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('does not delete a contact renamed during the wait before deletion', async () => {
    const calls = [];
    let liveName = BLOCK_CONTACT_NAME;
    let pauses = 0;
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact() {
          calls.push('delete');
        },
      },
      contact: {
        name: liveName,
        async unblock() {
          calls.push('unblock');
        },
      },
      chat: {
        async getContact() {
          return { name: liveName };
        },
        async unmute() {
          calls.push('unmute');
        },
      },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
      renamed: true,
      savedContact: false,
      async pause() {
        pauses += 1;
        if (pauses === 2) liveName = 'Alice Chan';
      },
    });
    assert.deepEqual(calls, ['unblock', 'unmute']);
    assert.equal(out.clearedRename, false);
    assert.equal(out.clearRenameSkipped, 'name_mismatch');
  });

  it('does not delete a contact when its name cannot be refreshed', async () => {
    const calls = [];
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact() {
          calls.push('delete');
        },
      },
      contact: {
        name: BLOCK_CONTACT_NAME,
        async unblock() {
          calls.push('unblock');
        },
      },
      chat: {
        async getContact() {
          throw new Error('lookup failed');
        },
        async unmute() {
          calls.push('unmute');
        },
      },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
    });
    assert.deepEqual(calls, ['unblock', 'unmute']);
    assert.equal(out.clearedRename, false);
    assert.deepEqual(out.errors, ['clear_rename:lookup failed']);
  });

  it('does not delete when the contact has no name', async () => {
    let deleteCalls = 0;
    const out = await unblockContact({
      client: {
        async deleteAddressbookContact() {
          deleteCalls += 1;
        },
      },
      contact: { async unblock() {} },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
      renamed: true,
      savedContact: false,
      pause: async () => {},
    });
    assert.equal(out.clearedRename, false);
    assert.equal(out.clearRenameSkipped, 'name_mismatch');
    assert.equal(deleteCalls, 0);
  });

  it('does not delete when the contact is null', async () => {
    let deleteCalls = 0;
    await assert.rejects(
      unblockContact({
        client: {
          async deleteAddressbookContact() {
            deleteCalls += 1;
          },
        },
        contact: null,
        digits: '85290000000',
        blockContactName: BLOCK_CONTACT_NAME,
      }),
      /contact\.unblock unavailable/,
    );
    assert.equal(deleteCalls, 0);
  });

  it('reports a missing delete API without saving a blank contact name', async () => {
    let saveCalls = 0;
    const out = await unblockContact({
      client: {
        async saveOrEditAddressbookContact() {
          saveCalls += 1;
        },
      },
      contact: { name: BLOCK_CONTACT_NAME, async unblock() {} },
      digits: '85290000000',
      blockContactName: BLOCK_CONTACT_NAME,
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

describe('labelUnsavedContact', () => {
  const LABEL = '（可疑推銷）';
  const run = async (contact) => {
    const saved = [];
    const client = { async saveOrEditAddressbookContact(...args) { saved.push(args); } };
    const out = await labelUnsavedContact({
      client,
      digits: '+852 6123 4567',
      contactName: LABEL,
      refreshUnsavedContact: async () => contact,
    });
    return { out, saved };
  };

  it('writes the label on an unsaved sender without syncing the phone book', async () => {
    const { out, saved } = await run({ isMyContact: false, name: undefined });
    assert.deepEqual(out, { labelled: true });
    assert.deepEqual(saved, [['85261234567', LABEL, '']]);
  });

  it('keeps the name of a contact the user saved', async () => {
    const { out, saved } = await run({ isMyContact: true, name: 'Ada' });
    assert.equal(out.skipped, 'contact_not_unsaved');
    assert.deepEqual(saved, []);
  });

  it('does not rewrite a contact that already has the label', async () => {
    const { out, saved } = await run({ isMyContact: true, name: LABEL });
    assert.equal(out.skipped, 'already_labelled');
    assert.deepEqual(saved, []);
  });

  it('does not label when the live contact cannot be read', async () => {
    const { out, saved } = await run(null);
    assert.equal(out.skipped, 'contact_not_unsaved');
    assert.deepEqual(saved, []);
  });
});
