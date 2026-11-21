'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deliverGuidedReview, invalidatePendingGuidedReview } = require('./deliver-review');
const { createReviewQueue } = require('./review-queue');
const { attachHandlers } = require('../whatsapp-bot');
const { createLlmReviewCooldownStore } = require('./llm-review-cooldown');

function queueForTest(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createReviewQueue({ filePath: path.join(dir, 'queue.json') });
}

it('edits cancel pending guided cards and bypass the recommendation cooldown', async (t) => {
  const queue = queueForTest(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const delivery = deliverGuidedReview({
    queue, result: { deferred: true, chatId: 'chat@c.us', messageId: 'm', reviewMessages: ['old'] },
    maskClient: { maskMessages: async () => { started(); await gate; throw new Error('offline'); } },
    forward: async () => { writes++; }, sendText: async () => { writes++; }, sendPoll: async () => { writes++; },
  });
  await ready;
  t.after(() => release());
  const store = createLlmReviewCooldownStore();
  store.set('chat@c.us', Date.now());
  let masks = 0;
  const client = { handlers: {}, on(event, fn) { this.handlers[event] = fn; } };
  attachHandlers(client, {
    reviewQueue: queue, llmCooldownStore: store,
    env: { LLM_REVIEW_COOLDOWN_MS: '600000' },
    operator: { mode: () => 'guided', awaitingChoice: () => false },
    pacer: { exclusive: (fn) => fn(), pause: async () => {} },
    maskClient: { maskMessages: async () => { masks++; throw new Error('offline'); } },
  });
  await client.handlers.message_edit({
    type: 'chat', id: { _serialized: 'm' },
    getChat: async () => ({ id: { _serialized: 'chat@c.us' } }),
    getContact: async () => ({ isMyContact: true, id: { _serialized: '85299990000@c.us' } }),
  }, 'benign edited text', 'old');
  release();
  assert.equal((await delivery).skipped, 'edited');
  assert.equal(writes, 0);
  assert.equal(masks, 1);
  assert.equal(queue.findOpenByMessageId('m'), null);
  assert.equal(invalidatePendingGuidedReview(queue, 'missing'), 0);
});

it('a poll already in flight when edited is registered void rather than actionable', async (t) => {
  const queue = queueForTest(t);
  const delivery = await deliverGuidedReview({
    queue, result: { deferred: true, chatId: 'chat', messageId: 'm', reviewMessages: [] },
    sendPoll: async () => {
      assert.equal(invalidatePendingGuidedReview(queue, 'm'), 1);
      return { id: { _serialized: 'poll' } };
    },
  });
  assert.equal(delivery.pollId, 'poll');
  assert.equal(queue.get('poll').voidReason, 'edited');
  assert.equal(queue.findOpenByMessageId('m'), null);
});
