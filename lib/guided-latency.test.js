'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { measureGuidedLatency } = require('../test/support/guided-latency');
const { deliverGuidedReview } = require('./deliver-review');
const { createActionPacer } = require('./action-pacer');

for (const stage of ['mask', 'llm']) {
  for (const fails of [false, true]) {
    it(`guided ${stage} does not delay another chat archive (fails=${fails})`, async () => {
      const result = await measureGuidedLatency(200, { stage, fails });
      assert.equal(result.archivedWhilePending, true);
      assert.ok(result.events.indexOf('forward') < result.events.indexOf('poll'));
      assert.ok(result.events.indexOf('forward') < result.events.lastIndexOf('text'));
      assert.ok(result.events.lastIndexOf('text') < result.events.indexOf('poll'));
      assert.equal(result.events.filter((event) => event === 'poll').length, 1);
    });
  }
}

it('claims concurrent duplicates and keeps ordered writes exclusive without adding pauses', async () => {
  const records = [];
  const queue = {
    findOpenByMessageId: (id) => records.find((record) => record.messageId === id),
    add: (record) => records.push(record),
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let pauses = 0;
  let exclusiveRuns = 0;
  let insideExclusive = false;
  const pacer = createActionPacer({
    env: { WA_ACTION_GAP_MS: '3000' },
  });
  pacer.pause = async () => { pauses++; };
  const writes = [];
  let masks = 0;
  function deliver(id) {
    let texts = 0;
    const write = (kind) => {
      assert.equal(insideExclusive, true);
      writes.push({ id, kind });
      return { id: { _serialized: `poll-${id}` } };
    };
    return deliverGuidedReview({
      result: { deferred: true, chatId: 'chat', messageId: id, reviewMessages: [id] },
      queue,
      exclusive: (fn) => pacer.exclusive(async () => {
        assert.equal(insideExclusive, false);
        insideExclusive = true;
        exclusiveRuns++;
        try { return await fn(); } finally { insideExclusive = false; }
      }),
      maskClient: { async maskMessages() {
        assert.equal(insideExclusive, false);
        masks++;
        if (id === 'first') await gate;
        throw new Error('offline');
      } },
      forward: async () => write('forward'),
      sendText: async () => write(++texts === 1 ? 'text' : 'fallback'),
      sendPoll: async () => {
        const poll = write('poll');
        if (id === 'second') throw new Error('poll unavailable');
        return poll;
      },
    });
  }
  const first = deliver('first');
  assert.equal((await deliver('first')).skipped, 'duplicate');
  const second = deliver('second');
  await Promise.resolve();
  assert.equal(masks, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes.map(({ id, kind }) => `${id}:${kind}`), [
    'first:forward', 'first:text', 'first:poll',
    'second:forward', 'second:text', 'second:poll', 'second:fallback',
  ]);
  assert.equal(exclusiveRuns, 2);
  assert.equal(pauses, 0);
  assert.equal((await deliver('first')).skipped, 'duplicate');
  assert.equal(masks, 2);
});

it('releases a reservation after no poll so an empty explanation can retry', async () => {
  const queue = { findOpenByMessageId: () => null };
  const options = { result: { deferred: true, messageId: 'empty', reviewMessages: [] }, queue };
  assert.equal((await deliverGuidedReview(options)).skipped, 'no_poll');
  assert.equal((await deliverGuidedReview(options)).skipped, 'no_poll');
});

it('releases the duplicate claim when queuing the writes fails', async () => {
  const queue = { findOpenByMessageId: () => null };
  const options = { result: { deferred: true, messageId: 'retry' }, queue };
  await assert.rejects(deliverGuidedReview({
    ...options, exclusive: async () => { throw new Error('queue failed'); },
  }), /queue failed/);
  assert.equal((await deliverGuidedReview(options)).skipped, 'no_poll');
});
