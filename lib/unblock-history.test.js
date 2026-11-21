'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyReviewChoice, applyUnblockChoice } = require('./apply-review-choice');
const { appendBlockRecord, readRecentBlockRecords } = require('./block-log');
const { loadRecentBlocksForCommands, formatRecentBlocksList, resolveUnblockTarget } = require('./operator-commands');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') };
  const record = { chatId: '85290000000@c.us', digits: '85290000000' };
  const deps = { env, getChat: async () => ({}), archiveChat: async () => {}, blockContact: async () => ({ blocked: true }), unblockContact: async () => ({ unblocked: true }) };
  return { env, record, deps };
}

it('successful unblock removes history targets and a reblock restores them', async (t) => {
  const { env, record, deps } = setup(t);
  await applyReviewChoice(record, 'block', deps);
  assert.equal((await applyUnblockChoice(record, 'unblock', deps)).ok, true);
  const rows = readRecentBlockRecords(Infinity, env.BLOCK_LOG_PATH);
  assert.equal(rows.at(-1).unblocked, true);
  assert.deepEqual(loadRecentBlocksForCommands(env), []);
  assert.equal(formatRecentBlocksList(rows), '最近冇封鎖紀錄。');
  assert.equal(resolveUnblockTarget(null, { recentBlocks: rows }).kind, 'not_found');
  assert.equal(resolveUnblockTarget(record.digits, { recentBlocks: rows }).kind, 'not_found');
  await applyReviewChoice(record, 'block', deps);
  assert.equal(loadRecentBlocksForCommands(env).length, 1);
  assert.equal(resolveUnblockTarget(null, { recentBlocks: loadRecentBlocksForCommands(env) }).kind, 'record');
});

it('unblocks are applied before history limits without hiding other contacts', (t) => {
  const { env, record } = setup(t);
  appendBlockRecord({ chatId: 'other', blocked: true }, env.BLOCK_LOG_PATH);
  appendBlockRecord({ ...record, blocked: true }, env.BLOCK_LOG_PATH);
  appendBlockRecord({ ...record, unblocked: true }, env.BLOCK_LOG_PATH);
  assert.deepEqual(loadRecentBlocksForCommands(env, 1).map((row) => row.chatId), ['other']);
});

it('failed and kept unblocks do not clear block history', async (t) => {
  const { env, record, deps } = setup(t);
  await applyReviewChoice(record, 'block', deps);
  await applyUnblockChoice(record, 'keep', deps);
  await applyUnblockChoice(record, 'unblock', { ...deps, unblockContact: async () => ({ unblocked: false }) });
  await applyUnblockChoice(record, 'unblock', { ...deps, unblockContact: async () => { throw new Error('offline'); } });
  assert.equal(readRecentBlockRecords(Infinity, env.BLOCK_LOG_PATH).length, 1);
  assert.equal(loadRecentBlocksForCommands(env).length, 1);
});

it('unblock log failures remain best effort after a successful action', async (t) => {
  const { record, deps } = setup(t);
  const result = await applyUnblockChoice(record, 'unblock', { ...deps, recordBlock: async () => { throw new Error('disk full'); } });
  assert.equal(result.ok, true);
  assert.equal(result.logError, 'disk full');
  assert.match(result.text, /已解除封鎖/);
});
