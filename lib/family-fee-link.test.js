'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processIncomingMessage } = require('./handle-incoming');
const { primaryPathDeps, notScamLlmFetch, llmChatResponse } = require('./test-llm');

const cases = [
  ['notice', '媽，麻煩幫我轉帳交學校旅行費，學校通知喺呢個連結 https://bit.ly/trip-notice', false],
  ['transfer via link', '麻煩透過呢個連結轉帳交旅行費 https://bit.ly/trip-pay', true],
  ['pay at link', '請在此連結付款 https://bit.ly/trip-pay', false],
  ['English payment', 'Please transfer the fee via this link https://bit.ly/trip-pay', false],
  ['transfer to link', '請轉帳到呢個連結 https://bit.ly/trip-pay', true],
  ['urgent transfer', '請立即轉帳 https://bit.ly/trip-pay', true],
  ['send cash via link', '麻煩用呢個連結打錢 https://bit.ly/trip-pay', true],
  ['inline URL', '請透過呢個連結 https://bit.ly/x 轉帳', true],
  ['inline bare URL', '麻煩透過呢個連結 bit.ly/x 轉帳', true],
  ['inline URL without money ask', '麻煩透過呢個連結 https://bit.ly/x 轉帳', false],
];

it('family fee notice mask failure does not archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fee-'));
  const calls = [];
  try {
    const out = await processIncomingMessage(
      { type: 'chat', body: cases[0][1], chatId: 'fee-mask-fail@c.us', savedContact: true },
      primaryPathDeps({
        env: { CONTEXT_LLM_ENABLED: undefined, LLM_REVIEW_MIN_CONFIDENCE: '0.7',
          LLM_REVIEW_COOLDOWN_MS: '0', BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') },
        maskClient: { maskMessages: async () => ({ ok: false, reason: 'test_failure' }) },
        fetchImpl: async () => { calls.push('llm'); throw new Error('unexpected LLM'); },
        archiveChat: async () => calls.push('archive'),
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const context of [undefined, '0']) {
  for (const savedContact of [true, false]) {
    for (const [name, body, archive] of cases) {
      it(`family fee ${name}: context=${context ?? 'default'} saved=${savedContact}`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fee-'));
        const calls = [];
        try {
          const deps = primaryPathDeps({
            env: { CONTEXT_LLM_ENABLED: context, HEURISTIC_ENABLED: '1',
              LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0',
              BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') },
            fetchImpl: async (...args) => {
              calls.push('llm');
              return (context === '0' ? notScamLlmFetch() : llmChatResponse({ action: 'no_action', confidence: 0.9 }))(...args);
            },
            archiveChat: async () => calls.push('archive'),
            blockContact: async () => calls.push('block'),
          });
          const mask = deps.maskClient;
          deps.maskClient = { maskMessages: async (messages) => {
            calls.push('mask');
            return mask.maskMessages(messages);
          } };
          const out = await processIncomingMessage({ type: 'chat', body, chatId: 'family-fee@c.us', savedContact }, deps);
          console.log(`${name} context=${context ?? 'default'} saved=${savedContact}: ${out.decision.action} ${calls.join(',')}`);
          assert.equal(out.decision.action, archive ? 'archive' : 'ignore');
          assert.deepEqual(calls, archive ? ['archive'] : ['mask', 'llm']);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}
