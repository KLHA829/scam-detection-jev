'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessAbnormalFinanceUrgency,
  evaluateSavedMoneyWarn,
  applySavedMoneyWarnGuard,
  buildMoneyWarnNotice,
} = require('./money-warn');
const { hasSavedContactMoneyWarnSignal } = require('./scam-intent');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { deliverMoneyWarn } = require('./deliver-money-warn');
const { createReviewQueue } = require('./review-queue');
const { routeVote } = require('./self-chat');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rubric = loadRubric();

function incomingDeps(extra = {}) {
  const { env: extraEnv, ...rest } = extra;
  const { notScamLlmFetch, scamLlmFetch } = require('./test-llm');
  return {
    env: { CONTEXT_LLM_ENABLED: '0', ...extraEnv },
    maskClient: createStubJevlikeClient('benign'),
    rubric,
    llmReview: {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      fetchImpl: notScamLlmFetch(),
    },
    resolveNumber: async () => ({ digits: '85261230001', unresolvedLid: false }),
    archiveChat: async () => {},
    blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
    recordBlock: async () => {},
    threadContext: {
      prior: () => ['今日天氣好好', '聽日去行山？', 'OK呀'],
      push: () => {},
    },
    ...rest,
  };
}

describe('money warn patterns', () => {
  it('matches expanded FPS / 借錢 / PayMe cues without link hard-hit', () => {
    assert.equal(hasSavedContactMoneyWarnSignal('阿媽，急用，借錢5000俾我'), true);
    assert.equal(hasSavedContactMoneyWarnSignal('借錢俾我'), true);
    assert.equal(hasSavedContactMoneyWarnSignal('幫我轉數到呢個FPS'), true);
    assert.equal(hasSavedContactMoneyWarnSignal('用PayMe過數俾我'), true);
    assert.equal(hasSavedContactMoneyWarnSignal('買點數卡俾我充值'), true);
    assert.equal(hasSavedContactMoneyWarnSignal('唔好打電話，直接轉賬'), true);
  });
});

describe('assessAbnormalFinanceUrgency', () => {
  it('needs prior history; without it degrades to non-anomaly', () => {
    const out = assessAbnormalFinanceUrgency({
      priorBodies: [],
      currentBody: '急！立即轉帳俾我',
    });
    assert.equal(out.anomaly, false);
    assert.equal(out.degraded, true);
  });

  it('flags sudden urgent money when priors rarely mention money', () => {
    const out = assessAbnormalFinanceUrgency({
      priorBodies: ['食飯未', '幾時見', '好呀'],
      currentBody: '急！立即幫我轉帳到FPS',
    });
    assert.equal(out.anomaly, true);
    assert.ok(out.reasons.includes('sudden_urgent_money'));
  });
});

describe('evaluateSavedMoneyWarn', () => {
  it('warns saved contacts only', () => {
    assert.equal(
      evaluateSavedMoneyWarn({ savedContact: false, body: '借錢俾我' }).shouldWarn,
      false,
    );
    assert.equal(
      evaluateSavedMoneyWarn({
        savedContact: true,
        body: '借錢俾我',
        priorBodies: [],
      }).shouldWarn,
      true,
    );
  });

  it('elevates when history supports anomaly', () => {
    const out = evaluateSavedMoneyWarn({
      savedContact: true,
      body: '急！立即轉帳俾我',
      priorBodies: ['食飯', '幾時見', 'OK'],
    });
    assert.equal(out.shouldWarn, true);
    assert.equal(out.elevated, true);
    assert.equal(out.kind, 'abnormal_finance');
  });
});

describe('applySavedMoneyWarnGuard', () => {
  it('suppresses LLM archive for saved money warn but keeps link heuristic archive', () => {
    const suppressed = applySavedMoneyWarnGuard(
      { action: 'archive', archiveReason: 'llm_review_scam' },
      { shouldWarn: true },
      { hit: false },
    );
    assert.equal(suppressed.action, 'ignore');

    const kept = applySavedMoneyWarnGuard(
      { action: 'archive', archiveReason: 'obvious_scam' },
      { shouldWarn: true },
      { hit: true, id: 'lookalike_domain' },
    );
    assert.equal(kept.action, 'archive');
  });
});

describe('processIncomingMessage saved money warn', () => {
  it('does not archive or block saved money ask when LLM says scam', async () => {
    const { scamLlmFetch } = require('./test-llm');
    let archived = false;
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '媽，急用，借錢俾我，唔好打電話',
        chatId: '85261230001@c.us',
        savedContact: true,
        messageId: 'saved-borrow',
      },
      incomingDeps({
        fetchImpl: scamLlmFetch(),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: scamLlmFetch(),
        },
        archiveChat: async () => {
          archived = true;
        },
        blockContact: async () => {
          blocked = true;
        },
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.moneyWarn.shouldWarn, true);
    assert.equal(archived, false);
    assert.equal(blocked, false);
  });

  it('still blocks unsaved malicious-host match (unchanged)', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/pay',
        chatId: '85260000099@c.us',
        savedContact: false,
        messageId: 'unsaved-malicious',
      },
      {
        maskClient: createStubJevlikeClient('benign'),
        rubric,
        env: { CONTEXT_LLM_ENABLED: '0' },
        resolveNumber: async () => ({ digits: '85260000099', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'block');
    assert.equal(blocked, true);
    assert.equal(out.moneyWarn.shouldWarn, false);
  });

  it('adds finance_elevated to llm trigger for unsaved sudden money ask', async () => {
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '急！立即幫我轉帳到FPS',
        chatId: '85269990088@c.us',
        savedContact: false,
        messageId: 'unsaved-finance-elevate',
      },
      incomingDeps({
        env: { CONTEXT_LLM_ENABLED: '0', LLM_REVIEW_ENABLED: '0' },
        llmReview: { enabled: false },
      }),
    );
    assert.equal(out.financeElevated, true);
    assert.equal(out.llmTrigger.skipped, 'disabled');
  });
});

describe('deliverMoneyWarn dismiss poll', () => {
  it('queues a money_warn poll and routeVote acknowledges dismiss', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-warn-'));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const texts = [];
    const delivered = await deliverMoneyWarn({
      result: {
        chatId: '85261230001@c.us',
        formattedNumber: '85261230001',
        messageId: 'm1',
        moneyWarn: { shouldWarn: true, kind: 'saved_money_ask', elevated: false },
      },
      queue,
      listName: '阿媽',
      sendText: async (t) => {
        texts.push(t);
      },
      sendPoll: async () => ({ id: { _serialized: 'poll-money-1' } }),
    });
    assert.equal(delivered.delivered, true);
    assert.match(texts[0], /熟人借錢/);
    const route = routeVote(
      {
        parentMessage: { id: { _serialized: 'poll-money-1' } },
        selectedOptions: [{ name: '知道了' }],
      },
      { queue },
    );
    assert.equal(route.kind, 'money_warn');
    assert.equal(route.choice, 'ack');
  });
});

describe('buildMoneyWarnNotice copy', () => {
  it('uses abnormal headline only when elevated', () => {
    const normal = buildMoneyWarnNotice({ elevated: false });
    const abnormal = buildMoneyWarnNotice({ elevated: true, kind: 'abnormal_finance' });
    assert.match(normal, /熟人借錢/);
    assert.match(abnormal, /異常財務/);
    assert.match(normal, /唔會封存或封鎖/);
  });
});
