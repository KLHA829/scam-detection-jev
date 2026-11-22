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

const ENGLISH_ADVICE = [
  'Never send me your OTP',
  "Don't send me your OTP",
  'Do not send me your OTP',
  "We won't ask you to send us your OTP",
  "I won't ask you to send me your OTP",
  'No one will ask you to send me your OTP',
  'Never share the OTP code',
  'Don’t send me your OTP',
];
const ENGLISH_SCAMS = [
  'Send me your OTP',
  'please share the OTP code',
  "Don't hesitate to send me your OTP",
  'Never mind, send me your OTP',
  'Never send anyone your OTP. Send me your OTP',
  'Do not share your OTP, but please share the OTP code with me',
  'Never\nsend me your OTP',
];

describe('English OTP advice and solicitations', () => {
  for (const body of ENGLISH_ADVICE) {
    it(`English advice unit: ${body}`, () => {
      assert.equal(hasOtpForwardAsk(body), false);
    });
  }
  for (const body of ENGLISH_SCAMS) {
    it(`English solicitation unit: ${body}`, () => {
      assert.equal(hasOtpForwardAsk(body), true);
    });
  }
  it('English empty input has no OTP ask', () => {
    assert.equal(hasOtpForwardAsk(''), false);
    assert.equal(hasOtpForwardAsk(null), false);
  });
  it('English advice fails closed when masking fails', async () => {
    let reviews = 0;
    const out = await processIncomingMessage({
      type: 'chat', body: 'Never send me your OTP https://bit.ly/otp',
      chatId: '85269990001@c.us', savedContact: false, messageId: 'english-mask-error',
    }, incomingDeps({
      env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
      maskClient: { maskMessages: async () => { throw new Error('mask unavailable'); } },
      llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: async () => {
        reviews += 1;
        throw new Error('must not review');
      } },
      archiveChat: async () => { assert.fail('must not archive'); },
    }));
    assert.equal(out.decision.action, 'ignore');
    assert.equal(reviews, 0);
  });
  for (const [body, expected] of [
    ...ENGLISH_ADVICE.map((body) => [body, 'ignore']),
    ...ENGLISH_SCAMS.map((body) => [body, 'archive']),
    ['切勿把驗證碼發給我', 'ignore'],
  ]) {
    it(`English handler comparison: ${body}`, async () => {
      let reviews = 0;
      const archives = [];
      const { notScamLlmFetch } = require('./test-llm');
      const fetchImpl = notScamLlmFetch();
      const out = await processIncomingMessage({
        type: 'chat', body: `${body} https://bit.ly/otp`,
        chatId: '85269990000@c.us', savedContact: false,
        messageId: `english-${body}`,
      }, incomingDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
        llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: async (...args) => {
          reviews += 1;
          return fetchImpl(...args);
        } },
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => { throw new Error('OTP must not block'); },
      }));
      console.log(JSON.stringify({ body, action: out.decision.action, archives, reviews }));
      assert.equal(out.decision.action, expected);
      assert.equal(reviews, expected === 'ignore' ? 1 : 0);
      assert.deepEqual(archives, expected === 'ignore' ? [] : ['obvious_scam']);
    });
  }
});

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
  const { env: extraEnv, ...rest } = extra;
  const { notScamLlmFetch } = require('./test-llm');
  return {
    env: { CONTEXT_LLM_ENABLED: '0', ...extraEnv },
    maskClient: createStubJevlikeClient('benign'),
    llmReview: {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      fetchImpl: notScamLlmFetch(),
    },
    resolveNumber: async () => ({ digits: '85269990000', unresolvedLid: false }),
    archiveChat: async () => {},
    blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
    recordBlock: async () => {},
    ...rest,
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
  it('archives bait when the LLM flags scam and does not block on the words', async () => {
    const { scamLlmFetch } = require('./test-llm');
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
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: scamLlmFetch(),
        },
        archiveChat: async (reason) => reasons.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.equal(blocked, false);
    assert.deepEqual(reasons, ['llm_review_scam']);
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

  it('resolveIncomingMessageLabel stays unknown on a news quote until LLM', () => {
    const out = resolveIncomingMessageLabel(null, NEWS);
    assert.equal(out.label, 'unknown');
    assert.equal(out.archiveReason, null);
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

  it('ignores a news quote when the LLM says not_scam', async () => {
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
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(blocked, false);
  });

  it('archives a self-OTP delivery when the LLM flags scam and does not block', async () => {
    const { scamLlmFetch } = require('./test-llm');
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
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: scamLlmFetch(),
        },
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
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
      incomingDeps({ llmReview: { enabled: false } }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'obvious_scam');
    assert.equal(out.heuristic.id, 'lookalike_domain');
  });
});
