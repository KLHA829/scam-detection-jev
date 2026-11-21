'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createActionPacer } = require('../lib/action-pacer');
const { blockAndRename } = require('../lib/wa-actions');
const { processIncomingMessage } = require('../lib/handle-incoming');
const { loadRubric } = require('../lib/score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

process.env.MALICIOUS_HOSTS_PATH = path.join(__dirname, '..', 'data', 'malicious-hosts.json');

const rubric = loadRubric();
const env = { LLM_REVIEW_ENABLED: 'false' };

async function measure(gapMs) {
  const pacer = createActionPacer({ env: { WA_ACTION_GAP_MS: String(gapMs) } });
  const deps = (digits) => ({
    env,
    maskClient: createStubJevlikeClient(),
    rubric,
    exclusive: (fn) => pacer.exclusive(fn),
    pauseAction: () => pacer.pause(),
    resolveNumber: async () => ({ digits, unresolvedLid: false }),
    archiveChat: async () => {},
    blockContact: (info) =>
      blockAndRename({
        client: { saveOrEditAddressbookContact: async () => {} },
        contact: { block: async () => {} },
        chat: { mute: async () => {} },
        digits: info.digits,
        contactName: info.contactName,
        pause: () => pacer.pause(),
      }),
    recordBlock: async () => {},
  });
  const timed = async (promise) => {
    const t0 = performance.now();
    const result = await promise;
    return { result, ms: performance.now() - t0 };
  };
  const scam = timed(processIncomingMessage(
    { type: 'chat', body: '登入 https://malicious-block-test.invalid/x', chatId: 'b@c.us', savedContact: false, messageId: 'b1' },
    deps('85290002222'),
  ));
  await new Promise((resolve) => setImmediate(resolve));
  const benign = (id) => timed(processIncomingMessage(
    { type: 'chat', body: '今晚食咩？', chatId: 'a@c.us', savedContact: true, messageId: id },
    deps('85290001111'),
  ));
  const [b, a1, a2] = await Promise.all([scam, benign('a1'), benign('a2')]);
  assert.equal(b.result.decision.action, 'block');
  assert.equal(b.result.blocked, true);
  assert.equal(a1.result.decision.action, 'ignore');
  assert.equal(a2.result.decision.action, 'ignore');
  return { b: b.ms, a1: a1.ms, a2: a2.ms };
}

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

async function main() {
  const runs = 3;
  console.log('WA_ACTION_GAP_MS | runs | A ignore #1 median (ms) | A ignore #2 median (ms) | B block median (ms)');
  for (const gap of [1000, 3000]) {
    const rows = [];
    for (let i = 0; i < runs; i++) rows.push(await measure(gap));
    console.log(
      `${gap} | ${runs} | ${median(rows.map((r) => r.a1)).toFixed(1)} | ${median(rows.map((r) => r.a2)).toFixed(1)} | ${median(rows.map((r) => r.b)).toFixed(1)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
