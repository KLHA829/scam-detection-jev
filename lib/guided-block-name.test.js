'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyReviewChoice, applyUnblockChoice } = require('./apply-review-choice');
const { blockAndRename, unblockContact } = require('./wa-actions');
const { contactNameForBlock } = require('./block-policy');
const { createReviewQueue } = require('./review-queue');

for (const [scenario, latest, expectedSaved, expectedRename] of [
  ['a contact saved', { isMyContact: true, name: 'Alice Chan' }, true, false],
  ['a contact named', { isMyContact: false, name: 'Alice Chan' }, true, false],
  ['an unnamed saved contact', { isMyContact: true, name: '' }, true, false],
  ['an unsaved contact', { isMyContact: false, name: '' }, false, true],
  ['a temporary bot contact', { isMyContact: true, name: contactNameForBlock() }, false, true],
  ['a missing contact', null, false, false],
  ['a failed contact lookup', new Error('lookup failed'), false, false],
]) {
  it(`guided block preserves ${scenario} during rename pacing`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-rename-race-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') };
    let renamed = false;
    let blocked = false;
    let pauses = 0;
    let contact = { isMyContact: false, name: '', async block() { blocked = true; } };
    const result = await applyReviewChoice({
      chatId: '9@c.us', digits: '9', contactName: contactNameForBlock(),
    }, 'block', {
      env,
      getChat: async () => ({}),
      getContact: async () => {
        if (contact instanceof Error) throw contact;
        return contact;
      },
      archiveChat: async () => {},
      blockContact: (info) => blockAndRename({
        ...info,
        digits: info.record.digits,
        client: { async saveOrEditAddressbookContact() { renamed = true; } },
        pause: async () => {
          if (++pauses === 2) contact = latest;
        },
      }),
    });
    assert.equal(renamed, expectedRename);
    assert.equal(blocked, true);
    assert.equal(result.blocked, true);
    assert.equal(result.renamed, expectedRename);
    assert.equal(result.savedContact, expectedSaved);
    const logged = JSON.parse(fs.readFileSync(env.BLOCK_LOG_PATH, 'utf8').trim());
    assert.equal(logged.savedContact, expectedSaved);
    assert.equal(logged.contactName, expectedSaved ? null : contactNameForBlock());
    assert.equal(logged.renamed, expectedRename);
    if (latest instanceof Error) assert.deepEqual(logged.errors, ['rename:lookup failed']);
  });
}

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

it('guided reblocks from two pending polls retain temporary contact cleanup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-reblock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') };
  const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
  const record = {
    chatId: '85290000000@c.us', digits: '85290000000', savedContact: false,
    contactName: contactNameForBlock(),
  };
  for (const pollId of ['first', 'second']) queue.add({ ...record, pollId });
  let blocks = 0;
  let deleted = false;
  const contact = {
    isMyContact: false, name: '',
    async block() { blocks += 1; },
    async unblock() {},
  };
  const client = {
    async saveOrEditAddressbookContact(phone, name) {
      contact.name = name;
      contact.isMyContact = true;
    },
    async deleteAddressbookContact() { deleted = true; },
  };
  const chat = { async archive() {} };
  const deps = {
    env,
    getChat: async () => chat,
    getContact: async () => contact,
    archiveChat: (row) => row.archive(),
    blockContact: ({ contactName }) => blockAndRename({
      client, contact, chat, digits: record.digits, contactName,
    }),
    unblockContact: (info) => unblockContact({ ...info, client }),
  };
  const first = await applyReviewChoice(queue.consume('first'), 'block', deps);
  assert.equal(first.renamed, true);
  const second = await applyReviewChoice(queue.consume('second'), 'block', deps);
  const unblocked = await applyUnblockChoice({
    ...record, ...second, blockContactName: record.contactName,
  }, 'unblock', deps);
  t.diagnostic(JSON.stringify({ blocks, savedContact: second.savedContact, renamed: second.renamed, deleted }));
  assert.equal(blocks, 2);
  assert.equal(unblocked.unblocked, true);
  assert.equal(deleted, true);
  assert.equal(second.savedContact, false);
  assert.equal(second.renamed, true);
  const logged = fs.readFileSync(env.BLOCK_LOG_PATH, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logged[1].savedContact, false);
  assert.equal(logged[1].contactName, record.contactName);
});
