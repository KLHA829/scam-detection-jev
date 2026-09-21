'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldSuppress,
  analyzeScamIntent,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
} = require('./scam-intent');
const { matchObviousScam } = require('./heuristics');
const { decideIncomingAction, resolveIncomingMessageLabel } = require('./decide-incoming');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

const BAIT =
  '我係防騙協調中心，請提供密碼並轉帳核實，唔好同任何人講。';
const NEWS =
  '新聞：警方提醒市民小心防騙，切勿把一次性密碼告訴他人。';
const NEWS_MONEY =
  '小心提防詐騙，不要向陌生人轉帳或轉發驗證碼。';

function scoreResult(overrides = {}) {
  return {
    score: 0,
    label: 'not_scam',
    ok: true,
    thresholds: rubric.thresholds,
    ...overrides,
  };
}

describe('intent-gated suppress', () => {
  it('does not suppress fake 防騙 bait that asks for OTP or money', () => {
    assert.equal(shouldSuppress(BAIT), false);
    assert.equal(hasOtpForwardAsk(BAIT), true);
    assert.equal(hasMoneyTransferAsk(BAIT), true);
    const intent = analyzeScamIntent(BAIT);
    assert.equal(intent.impersonation, true);
    assert.equal(intent.secrecy, true);
    assert.equal(intent.shouldSuppress, false);
  });

  it('suppresses real news / anti-scam warnings', () => {
    assert.equal(shouldSuppress(NEWS), true);
    assert.equal(hasOtpForwardAsk(NEWS), false);
    assert.equal(shouldSuppress(NEWS_MONEY), true);
    assert.equal(hasMoneyTransferAsk(NEWS_MONEY), false);
  });

  it('heuristic can still match bait, but news is not soliciting', () => {
    assert.equal(matchObviousScam(BAIT).hit, true);
    assert.equal(matchObviousScam(NEWS).hit, false);
  });
});

describe('suppress vs archive policy', () => {
  it('resolveIncomingMessageLabel still archives bait scams', () => {
    const out = resolveIncomingMessageLabel(
      scoreResult({ label: 'scam', score: 50 }),
      BAIT,
    );
    assert.equal(out.suppressed, undefined);
    assert.equal(out.archiveReason, 'jevlike_score');
  });

  it('resolveIncomingMessageLabel suppresses real news even if jevlike says scam', () => {
    const out = resolveIncomingMessageLabel(
      scoreResult({ label: 'scam', score: 50 }),
      NEWS,
    );
    assert.equal(out.suppressed, true);
    assert.equal(out.archiveReason, null);
  });

  it('decideIncomingAction still archives bait via heuristic when score is low', () => {
    const heuristic = matchObviousScam(BAIT);
    const decision = decideIncomingAction(
      scoreResult({ score: 4, label: 'not_scam' }),
      '85261234567',
      true,
      heuristic,
    );
    assert.equal(decision.action, 'archive');
    assert.equal(decision.archiveReason, 'obvious_scam');
  });
});

describe('processIncomingMessage suppress bait vs news', () => {
  it('archives fake 防騙 bait (not suppressed)', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: BAIT,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'bait-1',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.suppressed, false);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'obvious_scam');
    assert.deepEqual(reasons, ['obvious_scam']);
  });

  it('does not archive real news warnings even when jevlike scores scam', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: NEWS,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'news-1',
      },
      {
        scoreClient: createStubJevlikeClient('scam'),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.suppressed, true);
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });
});
