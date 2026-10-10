'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldSuppress,
  analyzeScamIntent,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
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
    assert.equal(hasOtpForwardAsk(NEWS_MONEY), false);
  });

  it('keeps a real OTP ask that follows a negated clause or 不要緊', () => {
    for (const text of [
      '不要緊，請把驗證碼發給我',
      '不要緊請把驗證碼發給我',
      '切勿轉帳。請把驗證碼發給我',
      '切勿轉帳，請把驗證碼發給我',
    ]) {
      assert.equal(hasOtpForwardAsk(text), true, text);
      assert.equal(matchObviousScam(text).id, 'otp_harvest', text);
      assert.equal(shouldSuppress(text), false, text);
    }
  });

  it('does not treat 不小心 or an ordinary code as a warning', () => {
    assert.equal(shouldSuppress('不小心買多了兩張飛'), false);
    for (const text of [
      'referral code: GOLD88',
      'barcode: 123',
      'postcode: HK1',
      'encode: abc',
    ]) {
      assert.equal(shouldSuppress(text), false, text);
    }
    for (const text of [
      'your verification code is 123456',
      'whatsapp code: 123456',
      'do not share this code',
      NEWS,
    ]) {
      assert.equal(shouldSuppress(text), true, text);
    }
    const labeled = resolveIncomingMessageLabel(
      scoreResult({ label: 'scam', score: 90 }),
      '不小心買多了兩張飛',
    );
    assert.equal(labeled.suppressed, undefined);
    assert.equal(labeled.archiveReason, 'jevlike_score');
  });

  it('still archives a money or customs solicit that also says 小心', () => {
    assert.equal(hasMoneyTransferAsk('小心, send USDT to this wallet now'), true);
    assert.equal(shouldSuppress('小心, send USDT to this wallet now'), false);
    assert.equal(hasMoneyTransferAsk('小心 send money to my account'), true);
    assert.equal(shouldSuppress('小心 send money to my account'), false);
    assert.equal(hasMoneyTransferAsk('小心，不要 send USDT to this wallet'), false);
    assert.equal(shouldSuppress('小心，不要 send USDT to this wallet'), true);
    assert.equal(shouldSuppress('小心，WhatsApp 官方通知：否則封號'), true);
    assert.equal(shouldSuppress('警方提醒：您的驗證碼即將過期'), true);
    assert.equal(hasImpersonationClaim('我係去銀行攞錢'), false);
    assert.notEqual(
      matchObviousScam('我係去銀行攞錢，請即刻轉帳').id,
      'impersonation_solicitation',
    );
    assert.equal(hasImpersonationClaim('我係銀行職員'), true);
    assert.equal(hasImpersonationClaim(BAIT), true);
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

  it('blocks an unsaved USDT or customs solicit that also warns', async () => {
    async function run(body) {
      let blocked = 0;
      const out = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: 'solicit@c.us',
          savedContact: false,
          messageId: body,
        },
        {
          scoreClient: createStubJevlikeClient('benign'),
          rubric,
          resolveNumber: async () => ({ digits: '85260003333', unresolvedLid: false }),
          archiveChat: async () => {},
          blockContact: async () => {
            blocked += 1;
            return { renamed: true, blocked: true, muted: true, errors: [] };
          },
          recordBlock: async () => {},
        },
      );
      return { out, blocked };
    }

    const usdt = await run('小心, send USDT to this wallet now');
    assert.equal(usdt.out.suppressed, false);
    assert.equal(usdt.out.decision.action, 'block');
    assert.equal(usdt.out.decision.blockReason, 'obvious_scam');
    assert.equal(usdt.blocked, 1);

    const customs = await run('小心，順豐包裹清關費 http://bit.ly/x');
    assert.equal(customs.out.suppressed, false);
    assert.equal(customs.out.decision.action, 'block');
    assert.equal(customs.blocked, 1);

    const lookalike = await run('小心 https://whatspp.com/verify');
    assert.equal(lookalike.out.suppressed, false);
    assert.equal(lookalike.out.decision.action, 'block');
    assert.equal(lookalike.blocked, 1);
  });
});
