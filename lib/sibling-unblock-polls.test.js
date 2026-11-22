'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReviewQueue } = require('./review-queue');
const { siblingUnblockScenario } = require('../test/support/sibling-unblock-scenario');

it('retries a failed unblock through a sibling poll using real vote handlers', async (t) => {
  const { attachHandlers } = require('../whatsapp-bot');
  const { createOperatorState } = require('./operator-mode');
  const { createActionPacer } = require('./action-pacer');
  const { dir, filePath, queue } = setupQueue(t);
  const previousLog = process.env.BLOCK_LOG_PATH;
  process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
  t.after(() => {
    if (previousLog === undefined) delete process.env.BLOCK_LOG_PATH;
    else process.env.BLOCK_LOG_PATH = previousLog;
  });
  let unblockCalls = 0;
  const sent = [];
  const client = {
    info: { wid: { _serialized: 'me@c.us' } },
    handlers: {},
    on(event, fn) { this.handlers[event] = fn; },
    async sendMessage(_id, body) { sent.push(body); },
    async getChatById() {
      return {
        async getContact() {
          return {
            async unblock() {
              unblockCalls++;
              if (unblockCalls === 1) throw new Error('temporary WA failure');
            },
          };
        },
      };
    },
  };
  attachHandlers(client, {
    operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
    reviewQueue: queue,
    pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
  });
  const vote = (pollId) => client.handlers.vote_update({
    selectedOptions: [{ name: '解除封鎖' }], parentMessage: { id: { _serialized: pollId } },
  });
  await vote('first');
  assert.equal(unblockCalls, 1);
  assert.match(sent.at(-1), /temporary WA failure/);
  assert.equal(queue.get('first').resolved, false);
  await vote('second');
  assert.equal(unblockCalls, 2, 'sibling vote must retry the failed WhatsApp unblock');
  assert.match(sent.at(-1), /已解除封鎖/);
  const reloaded = createReviewQueue({ filePath });
  assert.equal(reloaded.get('first').resolved, true);
  assert.equal(reloaded.get('second').resolved, true);
});

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

it('reopens only siblings closed by the failed action and persists their retry state', (t) => {
  const { queue, filePath } = setupQueue(t);
  queue.add({ pollId: 'closed', kind: 'unblock', chatId: 'chat', resolved: true });
  queue.add({ pollId: 'other', kind: 'unblock', chatId: 'other', resolved: false });
  queue.consume('first');
  queue.add({ pollId: 'new', kind: 'unblock', chatId: 'chat', resolved: false });
  queue.release('first');
  const reloaded = createReviewQueue({ filePath });
  assert.equal(reloaded.get('first').resolved, false);
  assert.equal(reloaded.get('second').resolved, false);
  assert.equal(reloaded.get('closed').resolved, true);
  assert.equal(reloaded.get('other').resolved, false);
  assert.equal(reloaded.get('new').resolved, false);
  assert.ok(reloaded.consume('second'));
});

it('keeps consumed siblings retryable in memory when rollback persistence fails', (t) => {
  const { queue, filePath } = setupQueue(t);
  queue.consume('first');
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath);
  assert.throws(() => queue.release('first'));
  assert.equal(queue.get('first').resolved, false);
  assert.equal(queue.get('second').resolved, false);
  fs.rmdirSync(filePath);
  assert.ok(queue.consume('second'));
  assert.equal(queue.get('first').resolved, true);
  assert.equal(queue.get('second').resolved, true);
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
