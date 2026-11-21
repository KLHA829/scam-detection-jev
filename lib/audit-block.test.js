'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/block-log-test-setup');
const { handleWaMessage } = require('../whatsapp-bot');
const { blockAndRename } = require('./wa-actions');

it('downgrades an automatic block when a queued contact becomes saved', async () => {
  let blocked = false;
  let archived = false;
  const contact = { isMyContact: false, id: { _serialized: '85299990000@c.us' }, block: async () => { blocked = true; } };
  const chat = { id: contact.id, archive: async () => { archived = true; } };
  const result = await handleWaMessage({
    type: 'chat', body: 'https://malicious-block-test.invalid',
    getChat: async () => chat, getContact: async () => contact,
  }, {
    client: {}, env: {}, llmReview: { enabled: false },
    pacer: { pause: async () => {}, exclusive: async (fn) => { contact.isMyContact = true; return fn(); } },
  });
  assert.equal(blocked, false);
  assert.equal(archived, true);
  assert.equal(result.decision.action, 'archive');
});

it('automatic block checks fail closed and do not rename newly saved contacts', async () => {
  for (const live of [null, {}, { isMyContact: true }]) {
    const out = await blockAndRename({ contact: { block: async () => assert.fail('blocked') }, refreshUnsavedContact: async () => live });
    assert.equal(out.skipped, 'contact_not_unsaved');
  }
  const out = await blockAndRename({ contact: { block: async () => assert.fail('blocked') }, refreshUnsavedContact: async () => { throw new Error('offline'); } });
  assert.equal(out.blocked, false);
  let reads = 0;
  const contact = { isMyContact: false, block: async () => {} };
  const blocked = await blockAndRename({
    contact, digits: '85299990000', contactName: 'bot',
    client: { saveOrEditAddressbookContact: async () => assert.fail('renamed') },
    refreshUnsavedContact: async () => (++reads === 1 ? contact : { isMyContact: true }),
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.renamed, false);
});

it('explicit guided blocks still allow saved contacts', async () => {
  let blocked = false;
  await blockAndRename({ contact: { isMyContact: true, block: async () => { blocked = true; } } });
  assert.equal(blocked, true);
});
