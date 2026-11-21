'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

async function drive(repo = path.resolve(__dirname, '../..'), options = {}) {
  const { processIncomingMessage } = require(path.join(repo, 'lib/handle-incoming'));
  const { deliverGuidedReview } = require(path.join(repo, 'lib/deliver-review'));
  const { applyReviewChoice } = require(path.join(repo, 'lib/apply-review-choice'));
  const { createReviewQueue } = require(path.join(repo, 'lib/review-queue'));
  const { readRecentBlockRecords } = require(path.join(repo, 'lib/block-log'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-score-'));
  const env = {
    BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl'),
    REVIEW_QUEUE_PATH: path.join(dir, 'queue.json'),
    LLM_REVIEW_ENABLED: 'false',
  };
  try {
    const deps = {
      env,
      archiveChat: async () => { if (options.fail) throw new Error('archive down'); },
      blockContact: async () => { if (options.fail) throw new Error('block down'); return { blocked: true }; },
    };
    const input = { chatId: '85290000000@c.us', messageId: 'm1', type: 'chat',
      savedContact: false, body: 'https://malicious-block-test.invalid/' };
    await processIncomingMessage(input, deps);
    await processIncomingMessage({ ...input, savedContact: true }, deps);
    const result = await processIncomingMessage(input, { ...deps, operatorMode: 'guided' });
    const queue = createReviewQueue({ filePath: env.REVIEW_QUEUE_PATH });
    await deliverGuidedReview({ result, env, queue,
      sendPoll: async () => ({ id: { _serialized: 'poll1' } }),
    });
    const entry = createReviewQueue({ filePath: env.REVIEW_QUEUE_PATH }).get('poll1');
    const legacy = { ...entry, score: 0, pollId: 'legacy' };
    queue.add(legacy);
    const choices = [];
    for (const pollId of ['poll1', 'legacy']) {
      choices.push(await applyReviewChoice(queue.consume(pollId), 'block', {
        ...deps, getChat: async () => ({}),
      }));
    }
    const blockLines = fs.readFileSync(env.BLOCK_LOG_PATH, 'utf8').trim().split('\n');
    const records = readRecentBlockRecords(20, env.BLOCK_LOG_PATH);
    return { blockLines, records, entry, choices, legacy: createReviewQueue({ filePath: env.REVIEW_QUEUE_PATH }).get('legacy') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  drive(path.resolve(process.argv[2] || '.')).then(({ blockLines, entry }) => {
    console.log('BLOCK_LOG ' + blockLines.join('\nBLOCK_LOG '));
    console.log('REVIEW_QUEUE ' + JSON.stringify(entry));
  }).catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { drive };
