'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createThreadContext,
  joinWindow,
  pickContextScore,
} = require('./thread-context');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { llmOffDeps } = require('./test-llm');

const rubric = loadRubric();

describe('thread window', () => {
  it('keeps the current message and drops the oldest prior that does not fit', () => {
    const joined = joinWindow(['AAAA', 'BB', 'CCC'], 'ZZ', 9);
    assert.equal(joined, 'BB\nCCC\nZZ');
  });

  it('stores only CONTEXT_TURNS - 1 prior messages', () => {
    const thread = createThreadContext({ turns: 4 });
    thread.push('c', 'one');
    thread.push('c', 'two');
    thread.push('c', 'three');
    thread.push('c', 'four');
    assert.deepEqual(thread.prior('c'), ['two', 'three', 'four']);
  });
});

describe('context score merge (offline helper only)', () => {
  it('pickContextScore prefers the higher score unless the current sentence is long and safe', () => {
    const single = { score: 30, ok: true, thresholds: rubric.thresholds, label: 'unknown' };
    const window = { score: 70, ok: true, thresholds: rubric.thresholds, label: 'scam' };
    const raised = pickContextScore({
      single,
      window,
      currentText: '係呢條',
      windowText: '舊句\n係呢條',
      env: {},
      rubric,
    });
    assert.equal(raised.source, 'window');
    const safe = {
      score: 5,
      ok: true,
      thresholds: rubric.thresholds,
      label: 'not_scam',
    };
    const veto = pickContextScore({
      single: safe,
      window,
      currentText: '今晚食飯嗎？我轉帳比你 AA，唔使急，七點喺旺角見。',
      windowText: '驗證碼\n今晚食飯',
      env: {},
      rubric,
    });
    assert.equal(veto.source, 'single');
  });

  it('inbound path does not call jevlike score (thread kept for review copy only)', async () => {
    const thread = createThreadContext({ turns: 4 });
    let scoreCalls = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '我係順豐客服',
        chatId: 'split@c.us',
        savedContact: false,
        messageId: 'split-1',
      },
      llmOffDeps({
        threadContext: thread,
        maskClient: {
          async scoreText() {
            scoreCalls += 1;
            return { prob_scam: 0.9 };
          },
          async maskMessages(messages) {
            return createStubJevlikeClient().maskMessages(messages);
          },
        },
      }),
    );
    assert.equal(scoreCalls, 0);
    assert.equal(out.scoreSource, 'llm_primary');
    assert.equal(out.decision.action, 'ignore');
  });
});
