'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReviewQueue } = require('./review-queue');
const { deliverGuidedReview } = require('./deliver-review');
const { attachHandlers } = require('../whatsapp-bot');

it('retries guided delivery after a failed queue save and keeps the retry after restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'q.json');
  const queue = createReviewQueue({ filePath });
  const tmp = `${filePath}.${process.pid}.tmp`;
  let sends = 0;
  const options = {
    queue,
    result: { deferred: true, chatId: 'chat', messageId: 'dm-1', decision: { action: 'archive' } },
    sendPoll: async () => `poll-${++sends}`,
  };

  fs.mkdirSync(tmp);
  await assert.rejects(deliverGuidedReview(options), { path: tmp });
  assert.equal(sends, 1);
  const failedRecord = queue.get('poll-1');
  fs.rmdirSync(tmp);

  const retry = await deliverGuidedReview(options);
  const reloaded = createReviewQueue({ filePath });
  assert.deepEqual({
    failedRecord: failedRecord?.pollId ?? null,
    retry: retry.skipped,
    persistedPoll: reloaded.findOpenByMessageId('dm-1')?.pollId ?? null,
  }, {
    failedRecord: null,
    retry: null,
    persistedPoll: 'poll-2',
  });
  assert.equal(retry.pollId, 'poll-2');
  assert.equal(reloaded.get('poll-1'), null);
  assert.deepEqual(await deliverGuidedReview({ ...options, queue: reloaded }), { skipped: 'duplicate' });
  assert.equal(sends, 2);
});

it('accepts an unblock poll vote after a failed registration save and storage recovery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'q.json');
  const queue = createReviewQueue({ filePath });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(tmp);
  assert.throws(
    () => queue.add({ kind: 'unblock', pollId: 'unblock-1', chatId: 'chat', resolved: false }),
    { path: tmp },
  );
  assert.equal(createReviewQueue({ filePath }).get('unblock-1'), null);
  fs.rmdirSync(tmp);

  const sent = [];
  const client = {
    info: { wid: { _serialized: 'me@c.us' } }, handlers: {},
    on(event, fn) { this.handlers[event] = fn; },
    sendMessage: async (_id, text) => { sent.push(text); },
  };
  attachHandlers(client, { operator: {}, reviewQueue: queue, pacer: { exclusive: (fn) => fn() } });
  await client.handlers.vote_update({
    parentMessage: { id: { _serialized: 'unblock-1' } },
    selectedOptions: [{ name: '保持封鎖' }],
  });
  assert.deepEqual(sent, ['保持封鎖。']);
  assert.equal(createReviewQueue({ filePath }).get('unblock-1').resolved, true);
});

for (const kind of ['review', 'unblock']) {
  it(`${kind} consumption survives a failed save and notifies the operator`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-save-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'q.json');
    const queue = createReviewQueue({ filePath });
    assert.equal(queue.consume('missing'), null);
    queue.add({ kind, pollId: 'p', chatId: 'chat', resolved: false });
    const before = queue.get('p');
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    assert.throws(() => queue.consume('p'));
    assert.equal(queue.get('p'), before);
    assert.equal(queue.get('p').resolved, false);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).items.p.resolved, false);
    const sent = [];
    let actions = 0;
    const client = {
      info: { wid: { _serialized: 'me@c.us' } }, handlers: {},
      on(event, fn) { this.handlers[event] = fn; },
      sendMessage: async (_id, text) => { sent.push(text); },
      getChatById: async () => { actions++; throw new Error('must not act'); },
    };
    attachHandlers(client, {
      operator: {}, reviewQueue: queue,
      pacer: { exclusive: (fn) => fn() },
    });
    await client.handlers.vote_update({
      parentMessage: { id: { _serialized: 'p' } },
      selectedOptions: [{ name: kind === 'unblock' ? '解除封鎖' : '只封存' }],
    });
    assert.equal(actions, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /儲存選擇失敗/);
    assert.equal(queue.get('p').resolved, false);
    fs.rmdirSync(tmp);
    assert.equal(queue.consume('p').resolved, true);
    assert.equal(queue.consume('p'), null);
    assert.equal(createReviewQueue({ filePath }).get('p').resolved, true);
  });
}
