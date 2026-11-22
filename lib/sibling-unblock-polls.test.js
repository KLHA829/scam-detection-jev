'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReviewQueue } = require('./review-queue');
const { siblingUnblockScenario } = require('../test/support/sibling-unblock-scenario');

for (const choice of ['解除封鎖', '保持封鎖']) {
  it(`closes sibling unblock polls after ${choice} through real handlers`, async () => {
    const result = await siblingUnblockScenario({ choice });
    assert.deepEqual(result, {
      choice, blockCalls: 2, secondPending: false, bareTarget: 'not_found',
      unblockCalls: choice === '解除封鎖' ? 1 : 0,
    });
  });
}

function setupQueue(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'queue.json');
  const queue = createReviewQueue({ filePath });
  for (const pollId of ['first', 'second']) {
    queue.add({ pollId, kind: 'unblock', chatId: 'chat', resolved: false });
  }
  return { dir, filePath, queue };
}

it('persists sibling consumption without closing reviews or other chats; new blocks stay actionable', (t) => {
  const { queue, filePath } = setupQueue(t);
  queue.add({ pollId: 'review', chatId: 'chat' });
  queue.add({ pollId: 'other', kind: 'unblock', chatId: 'other' });
  queue.consume('first');
  const reloaded = createReviewQueue({ filePath });
  assert.equal(reloaded.get('second').resolved, true);
  assert.equal(reloaded.consume('second'), null);
  assert.deepEqual(reloaded.findOpenUnblock().map((row) => row.pollId), ['other']);
  assert.ok(reloaded.consume('review'));
  reloaded.add({ pollId: 'new-block', kind: 'unblock', chatId: 'chat' });
  assert.ok(reloaded.consume('new-block'));
});

it('does not consume any siblings when persistence fails and allows retry', (t) => {
  const { queue, filePath } = setupQueue(t);
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath);
  assert.throws(() => queue.consume('first'));
  assert.equal(queue.get('first').resolved, false);
  assert.equal(queue.get('second').resolved, false);
  fs.rmdirSync(filePath);
  assert.ok(queue.consume('second'));
  assert.equal(queue.get('first').resolved, true);
});

it('keeps only the selected poll retryable after a failed WhatsApp action', (t) => {
  const { queue } = setupQueue(t);
  queue.consume('first');
  queue.release('first');
  assert.equal(queue.get('first').resolved, false);
  assert.equal(queue.get('second').resolved, true);
  assert.ok(queue.consume('first'));
});

it('handles missing, resolved and chatless polls without closing unrelated items', (t) => {
  const { queue } = setupQueue(t);
  assert.equal(queue.consume('missing'), null);
  queue.add({ pollId: 'chatless', kind: 'unblock' });
  assert.ok(queue.consume('chatless'));
  assert.equal(queue.consume('chatless'), null);
  assert.equal(queue.get('first').resolved, false);
  assert.equal(queue.get('second').resolved, false);
});
