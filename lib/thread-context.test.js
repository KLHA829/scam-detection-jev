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

const rubric = loadRubric();

function scoreOf(text) {
  const body = String(text || '');
  if (body.startsWith('今晚食飯')) return 0.05;
  if (body.includes('驗證碼') && body.includes('今晚')) return 0.92;
  if (body.includes('清關') && body.includes('順豐')) return 0.7;
  if (body.includes('係呢條') && body.includes('順豐')) return 0.66;
  if (body.includes('清關')) return 0.3;
  if (body.includes('係呢條')) return 0.3;
  if (body.includes('順豐')) return 0.1;
  if (body.includes('新聞')) return 0.8;
  return 0.04;
}

function deps(thread, extra = {}) {
  return {
    scoreClient: createStubJevlikeClient(scoreOf),
    rubric,
    threadContext: thread,
    resolveNumber: async () => ({ digits: '85260001111', unresolvedLid: false }),
    archiveChat: async () => {},
    blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
    recordBlock: async () => {},
    ...extra,
  };
}

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

describe('context score merge', () => {
  const thread = createThreadContext({ turns: 4 });

  it('archives a split lure from the higher window score', async () => {
    const first = await processIncomingMessage(
      {
        type: 'chat',
        body: '我係順豐客服',
        chatId: 'split@c.us',
        savedContact: false,
        messageId: 'split-1',
      },
      deps(thread),
    );
    assert.equal(first.scoreSource, 'single');
    assert.equal(first.decision.action, 'ignore');

    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: '件貨清關費未付',
        chatId: 'split@c.us',
        savedContact: false,
        messageId: 'split-2',
      },
      deps(thread),
    );
    assert.equal(second.scoreSource, 'window');
    assert.equal(second.scoreResult.score, 70);
    assert.equal(second.decision.action, 'archive');
  });

  it('keeps a long safe sentence even when the window contains an older lure', async () => {
    const local = createThreadContext({ turns: 4 });
    await processIncomingMessage(
      {
        type: 'chat',
        body: '驗證碼在上一句',
        chatId: 'benign@c.us',
        savedContact: true,
        messageId: 'benign-1',
      },
      deps(local),
    );
    const reply = '今晚食飯嗎？我轉帳比你 AA，唔使急，七點喺旺角見。';
    assert.ok(reply.length > 24);
    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: reply,
        chatId: 'benign@c.us',
        savedContact: false,
        messageId: 'benign-2',
      },
      deps(local),
    );
    assert.equal(second.scoreSource, 'single');
    assert.equal(second.scoreResult.score, 5);
    assert.equal(second.decision.action, 'ignore');
  });

  it('uses the window for a short follow-up', async () => {
    const local = createThreadContext({ turns: 4 });
    await processIncomingMessage(
      {
        type: 'chat',
        body: '我係順豐客服',
        chatId: 'short@c.us',
        savedContact: false,
        messageId: 'short-1',
      },
      deps(local),
    );
    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: '係呢條',
        chatId: 'short@c.us',
        savedContact: false,
        messageId: 'short-2',
      },
      deps(local),
    );
    assert.equal(second.scoreSource, 'window');
    assert.equal(second.decision.action, 'archive');
  });

  it('does not let a short reply after a warning archive', async () => {
    const local = createThreadContext({ turns: 4 });
    const news = '新聞：警方提醒市民小心防騙，切勿把一次性密碼告訴他人。';
    await processIncomingMessage(
      {
        type: 'chat',
        body: news,
        chatId: 'news@c.us',
        savedContact: false,
        messageId: 'news-1',
      },
      deps(local),
    );
    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: '你覺得點',
        chatId: 'news@c.us',
        savedContact: false,
        messageId: 'news-2',
      },
      deps(local),
    );
    assert.equal(second.scoreSource, 'window');
    assert.equal(second.suppressed, true);
    assert.equal(second.decision.action, 'ignore');
  });

  it('archives a short reply from the window but does not block on it', async () => {
    const local = createThreadContext({ turns: 4 });
    let blocked = 0;
    const client = {
      async scoreText(text) {
        return { prob_scam: String(text).includes('\n') ? 0.96 : 0.2 };
      },
    };
    const shared = {
      scoreClient: client,
      rubric,
      threadContext: local,
      resolveNumber: async () => ({ digits: '85260001111', unresolvedLid: false }),
      archiveChat: async () => {},
      blockContact: async () => {
        blocked += 1;
        return { renamed: true, blocked: true, muted: true, errors: [] };
      },
      recordBlock: async () => {},
    };
    await processIncomingMessage(
      {
        type: 'chat',
        body: '上一句',
        chatId: 'reply@c.us',
        savedContact: false,
        messageId: 'reply-1',
      },
      shared,
    );
    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: '好',
        chatId: 'reply@c.us',
        savedContact: false,
        messageId: 'reply-2',
      },
      shared,
    );
    assert.equal(second.scoreSource, 'window');
    assert.equal(second.scoreResult.score, 96);
    assert.equal(second.decision.action, 'archive');
    assert.equal(blocked, 0);
  });

  it('skips the window call once the single score is already at the block line', async () => {
    const local = createThreadContext({ turns: 4 });
    let calls = 0;
    const client = {
      async scoreText(text) {
        calls += 1;
        return { prob_scam: String(text).includes('第二') ? 0.96 : 0.1 };
      },
    };
    await processIncomingMessage(
      {
        type: 'chat',
        body: '第一句',
        chatId: 'skip@c.us',
        savedContact: false,
        messageId: 'skip-1',
      },
      deps(local, { scoreClient: client }),
    );
    calls = 0;
    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: '第二句已經好高',
        chatId: 'skip@c.us',
        savedContact: false,
        messageId: 'skip-2',
      },
      deps(local, { scoreClient: client }),
    );
    assert.equal(calls, 1);
    assert.equal(second.scoreSource, 'single');
    assert.equal(second.decision.action, 'block');
  });

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
});
