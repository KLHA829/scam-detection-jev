'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/block-log-test-setup');
const { handleWaMessage } = require('../whatsapp-bot');
const { blockAndRename } = require('./wa-actions');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { llmChatResponse } = require('./test-llm');

const listedScamLlm = () => ({
  enabled: true,
  apiUrl: 'http://llm.test/v1',
  fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
});

it('defers a queued automatic action when the contact is no longer confirmed unsaved', async (t) => {
  for (const { name, enabled, live } of [
    { name: 'saved before a block', enabled: '1', live: true },
    { name: 'saved before an archive', enabled: '0', live: true },
    { name: 'contact refresh failed', enabled: '0', live: null },
  ]) {
    await t.test(name, async () => {
      const events = [];
      let queued = false;
      const id = { _serialized: '85299990000@c.us' };
      const chat = { id, archive: async () => { events.push('archive'); } };
      const result = await handleWaMessage({
        type: 'chat', body: 'https://malicious-block-test.invalid',
        getChat: async () => chat,
        getContact: async () => {
          if (queued && live === null) throw new Error('contact lookup failed');
          return { id, isMyContact: queued && live, block: async () => { events.push('block'); } };
        },
      }, {
        client: {},
        env: { BLOCK_ENABLED: enabled, LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: createStubJevlikeClient(),
        llmReview: listedScamLlm(),
        pacer: { pause: async () => { queued = true; }, exclusive: (fn) => fn() },
      });
      assert.deepEqual(events, []);
      assert.equal(result.deferred, true);
      assert.equal(result.decision.action, 'archive');
      assert.equal(result.savedContact, live);
    });
  }
});

it('distinguishes its temporary contact from an operator save before archiving', async (t) => {
  for (const operatorSaved of [false, true]) {
    await t.test(operatorSaved ? 'operator saved' : 'bot saved', async () => {
      const events = [];
      const id = { _serialized: '85299990000@c.us' };
      let contact = { id, isMyContact: false, block: async () => { events.push('block'); } };
      const out = await handleWaMessage({
        type: 'chat', body: 'https://malicious-block-test.invalid',
        getChat: async () => ({ id, archive: async () => { events.push('archive'); } }),
        getContact: async () => contact,
      }, {
        client: {
          saveOrEditAddressbookContact: async (_digits, name) => {
            contact = { ...contact, name, isMyContact: true };
          },
        },
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: createStubJevlikeClient(),
        llmReview: listedScamLlm(),
        pacer: {
          pause: async () => {
            if (operatorSaved && contact.isMyContact) contact = { ...contact, name: 'Ada' };
          },
          exclusive: (fn) => fn(),
        },
      });
      assert.deepEqual(events, operatorSaved ? ['block'] : ['block', 'archive']);
      assert.equal(out.blocked, true);
      assert.equal(out.renamed, true);
      assert.equal(out.deferred, false);
      assert.equal(out.archived, !operatorSaved);
    });
  }
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
