'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

async function siblingUnblockScenario({ root = path.resolve(__dirname, '../..'), choice = '解除封鎖' } = {}) {
  const { attachHandlers } = require(path.join(root, 'whatsapp-bot'));
  const { createReviewQueue } = require(path.join(root, 'lib/review-queue'));
  const { createOperatorState } = require(path.join(root, 'lib/operator-mode'));
  const { createActionPacer } = require(path.join(root, 'lib/action-pacer'));
  const { resolveUnblockTarget } = require(path.join(root, 'lib/operator-commands'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-unblock-'));
  const previousLog = process.env.BLOCK_LOG_PATH;
  process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
  try {
    const env = { BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH };
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    const chatId = '85290000000@c.us';
    let unblockCalls = 0;
    let blockCalls = 0;
    let sent = 0;
    const client = {
      info: { wid: { _serialized: 'me@c.us' } },
      handlers: {},
      on(event, fn) { this.handlers[event] = fn; },
      async sendMessage() { return { id: { _serialized: `sent-${++sent}` } }; },
      async getChatById() {
        return {
          async archive() {},
          async getContact() {
            return {
              async block() { blockCalls++; },
              async unblock() { unblockCalls++; },
            };
          },
        };
      },
    };
    attachHandlers(client, {
      env,
      operator: createOperatorState({ env: { ...env, OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: createActionPacer({ env: { ...env, WA_ACTION_GAP_MS: '0' } }),
    });
    const vote = (pollId, label) => client.handlers.vote_update({
      selectedOptions: [{ name: label }], parentMessage: { id: { _serialized: pollId } },
    });
    for (const pollId of ['review-1', 'review-2']) {
      queue.add({ pollId, chatId, digits: '85290000000', resolved: false });
      await vote(pollId, '封鎖並封存');
    }
    const polls = queue.findOpenUnblock();
    if (polls.length !== 2) throw new Error(`Expected two guided unblock polls, got ${polls.length}`);
    // Isolate pending-poll resolution from the independent block-history fallback (#105).
    process.env.BLOCK_LOG_PATH = env.BLOCK_LOG_PATH = path.join(dir, 'poll-only-history.jsonl');
    await vote(polls[0].pollId, choice);
    const secondPending = !queue.get(polls[1].pollId).resolved;
    const bareTarget = resolveUnblockTarget(null, { openUnblockPolls: queue.findOpenUnblock(), recentBlocks: [] }).kind;
    await client.handlers.message_create({
      fromMe: true, body: '解除', hasQuotedMsg: false,
      async getChat() { return { id: { _serialized: 'me@c.us' } }; },
      async getContact() { return { isMe: true }; },
    });
    await vote(polls[1].pollId, '解除封鎖');
    return { choice, blockCalls, secondPending, bareTarget, unblockCalls };
  } finally {
    if (previousLog == null) delete process.env.BLOCK_LOG_PATH;
    else process.env.BLOCK_LOG_PATH = previousLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { siblingUnblockScenario };
