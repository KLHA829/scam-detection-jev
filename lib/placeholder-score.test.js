'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { drive } = require('../test/support/placeholder-score-drive');
const { appendBlockRecord, readRecentBlockRecords } = require('./block-log');
const { createReviewQueue } = require('./review-queue');

test('readers accept empty stores and mixed old and new block records', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-readers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl'), REVIEW_QUEUE_PATH: path.join(dir, 'queue.json') };
  assert.deepEqual(readRecentBlockRecords(20, env.BLOCK_LOG_PATH), []);
  assert.equal(createReviewQueue({ filePath: env.REVIEW_QUEUE_PATH }).get('missing'), null);
  const records = [{ chatId: 'old', score: 0 }, { chatId: 'new' }];
  for (const record of records) appendBlockRecord(record, env.BLOCK_LOG_PATH);
  assert.deepEqual(readRecentBlockRecords(20, env.BLOCK_LOG_PATH), records);
});

for (const fail of [false, true]) {
  test(`live records and logs omit placeholder scores (action failure: ${fail})`, async (t) => {
    const lines = [];
    for (const method of ['log', 'warn', 'error']) {
      t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
    }
    const { records, entry, choices, legacy } = await drive(undefined, { fail });
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(Object.hasOwn(record, 'score'), false);
      assert.equal(record.blocked, !fail);
      assert.equal(record.archived, !fail);
    }
    assert.equal(choices.length, 2);
    for (const choice of choices) {
      assert.equal(choice.ok, !fail);
      assert.equal(choice.blocked, !fail);
    }
    assert.ok(entry);
    assert.equal(Object.hasOwn(entry, 'score'), false);
    assert.equal(legacy.score, 0);
    assert.equal(legacy.resolved, true);
    assert.equal(lines.some((line) => /"score"\s*:/.test(line)), false);
  });
}
