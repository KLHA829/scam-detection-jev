'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./handle-incoming');

const deps = {
  env: { LLM_REVIEW_ENABLED: 'false', CONTEXT_LLM_ENABLED: 'false' },
};

function incoming(chatId, resolveNumber) {
  return handler.processIncomingMessage(
    { chatId, body: 'hello', type: 'chat' },
    { ...deps, resolveNumber },
  );
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test('inflight drops completed distinct chats and ignores messages without acquiring a lock', async () => {
  assert.equal(handler.inflightSize, 0);
  await handler.processIncomingMessage({ chatId: 'ignored', fromMe: true }, deps);
  assert.equal(handler.inflightSize, 0);
  await Promise.all(Array.from({ length: 100 }, (_, i) => incoming(`chat-${i}`)));
  assert.equal(handler.inflightSize, 0);
});

test('inflight preserves queued same-chat ordering and only the last completion deletes the entry', async () => {
  const firstGate = gate();
  const secondGate = gate();
  const secondStarted = gate();
  const order = [];
  const first = incoming('serial', async () => {
    order.push('first');
    await firstGate.promise;
    return { digits: null };
  });
  const second = incoming('serial', async () => {
    order.push('second');
    secondStarted.release();
    await secondGate.promise;
    return { digits: null };
  });
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  assert.equal(handler.inflightSize, 1);
  firstGate.release();
  await first;
  await secondStarted.promise;
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(handler.inflightSize, 1);
  const third = incoming('serial', async () => {
    order.push('third');
    return { digits: null };
  });
  await Promise.resolve();
  assert.deepEqual(order, ['first', 'second']);
  secondGate.release();
  await Promise.all([second, third]);
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.equal(handler.inflightSize, 0);
});

test('inflight cleans up throwing handlers and continues queued work after rejection', async () => {
  await assert.rejects(incoming('throws-alone', () => { throw new Error('alone'); }), /alone/);
  assert.equal(handler.inflightSize, 0);
  const blocked = gate();
  const started = gate();
  const first = incoming('throws-queued', () => { throw new Error('queued'); });
  const rejected = assert.rejects(first, /queued/);
  const second = incoming('throws-queued', async () => {
    started.release();
    await blocked.promise;
    return { digits: null };
  });
  await rejected;
  await started.promise;
  assert.equal(handler.inflightSize, 1);
  blocked.release();
  await second;
  assert.equal(handler.inflightSize, 0);
});
