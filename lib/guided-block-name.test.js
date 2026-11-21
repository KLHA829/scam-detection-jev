'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyReviewChoice, applyUnblockChoice } = require('./apply-review-choice');
const { blockAndRename, unblockContact } = require('./wa-actions');

for (const [scenario, live, preserve] of [
  ['saved named contact', { isMyContact: true, name: 'Alice Chan' }, true],
  ['saved unnamed contact', { isMyContact: true, name: '' }, true],
  ['named contact without saved flag', { isMyContact: false, name: 'Alice Chan' }, true],
  ['unsaved unnamed contact', { isMyContact: false, name: '' }, false],
]) {
  it(`guided block preserves live names: ${scenario}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-block-name-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { ...process.env, BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') };
    const calls = [];
    const contact = {
      ...live,
      async block() { calls.push('block'); },
      async unblock() { calls.push('unblock'); },
    };
    const client = {
      async saveOrEditAddressbookContact(phone, name) {
        calls.push('rename');
        contact.name = name;
      },
      async deleteAddressbookContact() { calls.push('delete'); },
    };
    const chat = { async archive() { calls.push('archive'); } };
    const record = {
      chatId: '85290000000@c.us', digits: '85290000000', savedContact: false,
      contactName: '封鎖·惡意域名',
    };
    const deps = {
      env,
      getChat: async () => chat,
      getContact: async () => contact,
      archiveChat: (row) => row.archive(),
      blockContact: ({ contactName }) => blockAndRename({
        client, contact, chat, digits: record.digits, contactName,
      }),
    };
    const result = await applyReviewChoice(record, 'block', deps);
    t.diagnostic(JSON.stringify({ scenario, name: contact.name, blocked: result.blocked, renamed: result.renamed }));
    assert.equal(result.blocked, true);
    assert.equal(contact.name, preserve ? live.name : record.contactName);
    assert.equal(result.renamed, !preserve);
    assert.equal(result.savedContact, preserve);
    assert.equal(calls.includes('archive'), true);
    const logged = JSON.parse(fs.readFileSync(env.BLOCK_LOG_PATH, 'utf8').trim());
    assert.equal(logged.savedContact, preserve);
    assert.equal(logged.contactName, preserve ? null : record.contactName);
    await applyUnblockChoice({ ...record, ...result, blockContactName: record.contactName }, 'unblock', {
      ...deps,
      unblockContact: (info) => unblockContact({ ...info, client }),
    });
    assert.equal(calls.includes('unblock'), true);
    assert.equal(calls.includes('delete'), !preserve);
  });
}

it('guided block does not rename when live contact lookup fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-block-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') };
  let archived = false;
  const result = await applyReviewChoice({ chatId: '1@c.us', savedContact: false }, 'block', {
    env,
    getChat: async () => ({}),
    getContact: async () => { throw new Error('contact unavailable'); },
    blockContact: async () => assert.fail('must not block or rename without contact'),
    archiveChat: async () => { archived = true; },
  });
  assert.equal(result.blocked, false);
  assert.equal(result.renamed, false);
  assert.equal(archived, true);
  const logged = JSON.parse(fs.readFileSync(env.BLOCK_LOG_PATH, 'utf8').trim());
  assert.deepEqual(logged.errors, ['block:contact unavailable']);
});
