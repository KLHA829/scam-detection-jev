'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { blockAndRename, clearUnsavedContactLabel, labelUnsavedContact, unblockContact } = require('./wa-actions');
const { createBotContactNames } = require('./bot-contact-names');

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
  const run = async (contact, { names = createBotContactNames(), isCurrent } = {}) => {
    const saved = [];
    const client = { async saveOrEditAddressbookContact(...args) { saved.push(args); } };
    const out = await labelUnsavedContact({
      client,
      digits: '+852 6123 4567',
      contactName: LABEL,
      refreshUnsavedContact: async () => contact,
      botContactNames: names,
      isCurrent,
    });
    return { out, saved, names };
  };

  it('writes the label on an unsaved sender without syncing the phone book, and records it', async () => {
    const { out, saved, names } = await run({ isMyContact: false, number: '85261234567', id: { _serialized: '85261234567@c.us' } });
    assert.deepEqual(out, { labelled: true });
    assert.deepEqual(saved, [['85261234567', LABEL, '']]);
    assert.equal(names.wrote({ isMyContact: true, number: '85261234567', id: { _serialized: '85261234567@c.us' }, name: LABEL }), true);
  });

  it('keeps the name of a contact the user saved', async () => {
    for (const name of ['Ada', LABEL]) {
      const { out, saved } = await run({ isMyContact: true, number: '85261234567', id: { _serialized: '85261234567@c.us' }, name });
      assert.equal(out.skipped, 'contact_not_unsaved', name);
      assert.deepEqual(saved, [], name);
    }
  });

  it('does not rewrite a contact the bot already labelled', async () => {
    const names = createBotContactNames();
    names.record(null, '85261234567', LABEL);
    const { out, saved } = await run({ isMyContact: true, number: '85261234567', id: { _serialized: '85261234567@c.us' }, name: LABEL }, { names });
    assert.equal(out.skipped, 'already_labelled');
    assert.deepEqual(saved, []);
  });

  it('writes nothing when the message was edited during pacing', async () => {
    const { out, saved, names } = await run({ isMyContact: false, number: '85261234567', id: { _serialized: '85261234567@c.us' } }, { isCurrent: () => false });
    assert.equal(out.skipped, 'stale');
    assert.deepEqual(saved, []);
    assert.equal(names.wrote({ isMyContact: true, number: '85261234567', id: { _serialized: '85261234567@c.us' }, name: LABEL }), false);
  });

  it('does not label when the live contact cannot be read', async () => {
    const { out, saved } = await run(null);
    assert.equal(out.skipped, 'contact_not_unsaved');
    assert.deepEqual(saved, []);
  });

  it('records an @lid sender under its contact id, so the next message still reads as unsaved', async () => {
    const lid = { isMyContact: false, number: '12345', id: { _serialized: '12345@lid', user: '12345' } };
    const { out, saved, names } = await run(lid);
    assert.deepEqual(out, { labelled: true });
    assert.deepEqual(saved, [['85261234567', LABEL, '']]);
    assert.equal(names.wrote({ ...lid, isMyContact: true, name: LABEL }), true);
  });
});

describe('clearUnsavedContactLabel', () => {
  const LABEL = '（可疑推銷）';
  const digits = '85261234567';
  const labelled = () => ({ isMyContact: true, name: LABEL, number: digits, id: { _serialized: `${digits}@c.us` } });
  const run = async (contact, { names, isCurrent, rename } = {}) => {
    const deleted = [];
    const client = { async deleteAddressbookContact(phone) { deleted.push(phone); } };
    const out = await clearUnsavedContactLabel({
      client,
      digits,
      contactName: LABEL,
      pause: async () => { if (rename) contact.name = rename; },
      refreshUnsavedContact: async () => contact,
      botContactNames: names,
      isCurrent,
    });
    return { out, deleted };
  };
  const botWrote = (contact) => {
    const names = createBotContactNames();
    names.record(contact, digits, LABEL);
    return names;
  };

  it('deletes a label the bot wrote and forgets it', async () => {
    const contact = labelled();
    const names = botWrote(contact);
    const { out, deleted } = await run(contact, { names });
    assert.deepEqual(out, { cleared: true });
    assert.deepEqual(deleted, [digits]);
    assert.equal(names.wrote(contact), false);
  });

  it('leaves a contact the user saved under the same text', async () => {
    const { out, deleted } = await run(labelled(), { names: createBotContactNames() });
    assert.equal(out.cleared, false);
    assert.deepEqual(deleted, []);
  });

  it('leaves a contact the user renamed during pacing or a stale verdict', async () => {
    const renamed = labelled();
    const first = await run(renamed, { names: botWrote(renamed), rename: '陳醫生' });
    assert.equal(first.out.cleared, false);
    const stale = labelled();
    const second = await run(stale, { names: botWrote(stale), isCurrent: () => false });
    assert.equal(second.out.skipped, 'stale');
    assert.deepEqual([...first.deleted, ...second.deleted], []);
  });

  it('propagates extraIds through labelUnsavedContact and clearUnsavedContactLabel', async () => {
    const digits = '85291230001';
    const lidId = '77777@lid';
    const contact = {
      isMyContact: true,
      name: LABEL,
      number: digits,
      id: { _serialized: `${digits}@c.us` },
    };
    const names = createBotContactNames();
    let saved = 0;
    let deleted = 0;
    const client = {
      async saveOrEditAddressbookContact() {
        saved += 1;
      },
      async deleteAddressbookContact() {
        deleted += 1;
      },
    };
    const labeled = await labelUnsavedContact({
      client,
      digits,
      contactName: LABEL,
      pause: async () => {},
      refreshUnsavedContact: async () => ({ isMyContact: false, id: { _serialized: `${digits}@c.us` } }),
      botContactNames: names,
      extraIds: [lidId],
    });
    assert.equal(labeled.labelled, true);
    assert.equal(saved, 1);
    assert.equal(names.wrote({ id: { _serialized: lidId }, name: LABEL }), true);

    const cleared = await clearUnsavedContactLabel({
      client,
      digits,
      contactName: LABEL,
      pause: async () => {},
      refreshUnsavedContact: async () => contact,
      botContactNames: names,
      extraIds: [lidId],
    });
    assert.equal(cleared.cleared, true);
    assert.equal(deleted, 1);
    assert.equal(names.wrote({ id: { _serialized: lidId }, name: LABEL }), false);
  });

  it('uses refreshContact in unblockContact and forgets botContactNames on clear', async () => {
    const digits = '85291230002';
    const lidId = '88888@lid';
    const blockName = '封鎖·惡意域名';
    const names = createBotContactNames();
    names.record({ id: { _serialized: `${digits}@c.us` } }, digits, blockName, { extraIds: [lidId] });
    const calls = [];
    const client = {
      async deleteAddressbookContact(phone) {
        calls.push(`delete:${phone}`);
      },
    };
    const staleContact = { id: { _serialized: `${digits}@c.us` }, name: blockName, async unblock() { calls.push('unblock1'); } };
    const refreshedUserSaved = { id: { _serialized: `${digits}@c.us` }, name: 'Mom', async unblock() {} };
    const keepUserName = await unblockContact({
      client,
      contact: staleContact,
      digits,
      blockContactName: blockName,
      renamed: true,
      savedContact: false,
      pause: async () => {},
      refreshContact: async () => refreshedUserSaved,
      botContactNames: names,
      extraIds: [lidId],
    });
    assert.equal(keepUserName.unblocked, true);
    assert.equal(keepUserName.clearedRename, false);
    assert.deepEqual(calls, ['unblock1']);
    assert.equal(names.wrote({ id: { _serialized: lidId }, name: blockName }), true);

    calls.length = 0;
    const contact2 = { id: { _serialized: `${digits}@c.us` }, name: blockName, async unblock() { calls.push('unblock2'); } };
    const refreshedBot = { id: { _serialized: `${digits}@c.us` }, name: blockName, async unblock() {} };
    const cleared = await unblockContact({
      client,
      contact: contact2,
      digits,
      blockContactName: blockName,
      renamed: true,
      savedContact: false,
      pause: async () => {},
      refreshContact: async () => refreshedBot,
      botContactNames: names,
      extraIds: [lidId],
    });
    assert.equal(cleared.unblocked, true);
    assert.equal(cleared.clearedRename, true);
    assert.deepEqual(calls, ['unblock2', `delete:${digits}`]);
    assert.equal(names.wrote({ id: { _serialized: `${digits}@c.us` }, name: blockName }), false);
    assert.equal(names.wrote({ id: { _serialized: lidId }, name: blockName }), false);
  });
});
