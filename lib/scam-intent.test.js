'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeScamIntent,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasSelfOtpLanguage,
} = require('./scam-intent');
const { matchObviousScam } = require('./link-rules');
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
const LOOKALIKE = '這不是詐騙，請登入 https://whatsapp-secure.com/login';

function scoreResult(overrides = {}) {
  return {
    score: 0,
    label: 'not_scam',
    ok: true,
    thresholds: rubric.thresholds,
    ...overrides,
  };
}

function incomingDeps(extra = {}) {
  return {
    scoreClient: createStubJevlikeClient('benign'),
    rubric,
    resolveNumber: async () => ({ digits: '85269990000', unresolvedLid: false }),
    archiveChat: async () => {},
    blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
    recordBlock: async () => {},
    ...extra,
  };
}

describe('solicit helpers stay off the archive path', () => {
  it('still sees an OTP or money ask, and does not hard-hit the text', () => {
    assert.equal(hasOtpForwardAsk(BAIT), true);
    assert.equal(hasMoneyTransferAsk(BAIT), true);
    const intent = analyzeScamIntent(BAIT);
    assert.equal(intent.impersonation, true);
    assert.equal(intent.secrecy, true);
    assert.equal(matchObviousScam(BAIT).hit, false);
    assert.equal(matchObviousScam(NEWS).hit, false);
    assert.equal(matchObviousScam(NEWS_MONEY).hit, false);
    assert.equal(hasOtpForwardAsk(NEWS), false);
    assert.equal(hasMoneyTransferAsk(NEWS_MONEY), false);
  });

  it('does not let a negated clause swallow the next ask', () => {
    const otp = '這不是詐騙，請勿告訴他人，請把驗證碼發給我';
    assert.equal(hasOtpForwardAsk(otp), true);
    assert.equal(matchObviousScam(otp).hit, false);

    const money = '小心，不要在街上交易，請轉帳到我的戶口';
    assert.equal(hasMoneyTransferAsk(money), true);
    assert.equal(matchObviousScam(money).hit, false);
  });

  it('keeps an OTP ask that has no comma, without archiving the text alone', () => {
    const otp = '這不是詐騙請勿告訴他人請把驗證碼發給我';
    assert.equal(hasOtpForwardAsk(otp), true);
    assert.equal(matchObviousScam(otp).hit, false);
    assert.equal(matchObviousScam('請識別驗證碼後發給我').hit, false);
    assert.equal(
      matchObviousScam('請把驗證碼發給我 https://bit.ly/fee').id,
      'short_link_solicit',
    );
  });

  it('does not treat a promo code as a WhatsApp OTP delivery', () => {
    assert.equal(hasSelfOtpLanguage('投資回報日日有，優惠 code: VIP88，快啲登記'), false);
    assert.equal(hasSelfOtpLanguage('您的 WhatsApp 驗證碼是 482913'), true);
  });
});

describe('score and link policy', () => {
  it('archives bait from the score and does not block on the words', async () => {
    let blocked = false;
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: BAIT,
        chatId: '85261234567@c.us',
        savedContact: false,
        messageId: 'bait-1',
      },
      incomingDeps({
        scoreClient: createStubJevlikeClient('scam'),
        archiveChat: async (reason) => reasons.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.equal(blocked, false);
    assert.deepEqual(reasons, ['jevlike_score']);
  });

  it('ignores bait when the score is low', async () => {
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: BAIT,
        chatId: '85261234567@c.us',
        savedContact: false,
        messageId: 'bait-low',
      },
      incomingDeps(),
    );
    assert.equal(out.decision.action, 'ignore');
  });

  it('resolveIncomingMessageLabel keeps a scam score on a news quote', () => {
    const out = resolveIncomingMessageLabel(
      scoreResult({ label: 'scam', score: 50 }),
      NEWS,
    );
    assert.equal(out.archiveReason, 'jevlike_score');
    assert.equal(out.heuristic.hit, false);
  });

  it('does not archive a low score just because the words ask for money', () => {
    const decision = decideIncomingAction(
      scoreResult({ score: 4, label: 'not_scam' }),
      '85261234567',
      false,
      matchObviousScam(BAIT),
    );
    assert.equal(decision.action, 'ignore');
    const linked = decideIncomingAction(
      scoreResult({ score: 4, label: 'not_scam' }),
      '85261234567',
      false,
      matchObviousScam(LOOKALIKE),
    );
    assert.equal(linked.action, 'archive');
    assert.equal(linked.archiveReason, 'obvious_scam');
  });

  it('archives a news quote when jevlike scores scam, and does not block it', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: NEWS,
        chatId: '85261234567@c.us',
        savedContact: false,
        messageId: 'news-1',
      },
      incomingDeps({
        scoreClient: createStubJevlikeClient('scam'),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.equal(blocked, false);
  });

  it('archives a self-OTP delivery from the score and does not block it', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '您的 WhatsApp 驗證碼是 482913',
        chatId: '85261110003@c.us',
        savedContact: false,
        messageId: 'self-otp',
      },
      incomingDeps({
        scoreClient: createStubJevlikeClient('scam'),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.equal(blocked, false);
  });

  it('does not block quoted tropes or an official 順豐 host', async () => {
    const samples = [
      '警方提醒：切勿用轉數快立即轉帳俾陌生人',
      '新聞：WhatsApp官方不會以封號為由聯絡你',
      '新聞：騙徒會話你驗證碼即將過期，切勿理睬',
      '警方呼籲切勿向陌生人的 USDT wallet 轉帳',
      '新聞：警方提醒市民，騙徒會叫你提供驗證碼。',
      '你的順豐清關文件已備妥 https://www.sf-express.com/hk/track',
      '你的順豐清關文件 https://evil.example/pay',
      '轉數快立即轉帳俾我',
      '請把驗證碼發給我',
    ];
    for (const body of samples) {
      const out = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: '85261110000@c.us',
          savedContact: false,
          messageId: `plain-${body.length}`,
        },
        incomingDeps(),
      );
      assert.equal(out.decision.action, 'ignore', body);
      assert.equal(matchObviousScam(body).hit, false, body);
    }
  });

  it('still archives an unsaved lookalike when the text says 這不是詐騙 (no auto-block)', async () => {
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: LOOKALIKE,
        chatId: '85269991111@c.us',
        savedContact: false,
        messageId: 'lookalike-warn',
      },
      incomingDeps(),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'obvious_scam');
    assert.equal(out.heuristic.id, 'lookalike_domain');
  });
});
