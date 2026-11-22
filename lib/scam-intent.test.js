'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/block-log-test-setup');

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
const { createRecentContext } = require('./context-llm');
const { notScamLlmFetch } = require('./test-llm');

const rubric = loadRubric();

const BAIT =
  '我係防騙協調中心，請提供密碼並轉帳核實，唔好同任何人講。';
const NEWS =
  '新聞：警方提醒市民小心防騙，切勿把一次性密碼告訴他人。';
const NEWS_MONEY =
  '小心提防詐騙，不要向陌生人轉帳或轉發驗證碼。';
const LOOKALIKE = '這不是詐騙，請登入 https://whatsapp-secure.com/login';

const STAFF_CASES = [
  ['clinic', '我係康健診所職員，覆診預約詳情 https://bit.ly/appointment', false],
  ['shop', '我是書店职员，活動詳情 https://bit.ly/event', false],
  ['empty', '', false],
  ['bank', '我係銀行職員，請查看通知 https://bit.ly/notice', true],
  ['police', '我是公安职员，請查看通知 https://bit.ly/notice', true],
  ['government', '我係政府職員，請查看通知 https://bit.ly/notice', true],
  ['government-boundary-14', '我係陳太，想通知你今日下午兩點有政府職員話要登記 https://bit.ly/x', true],
  ['government-beyond-15', '我係陳太，想通知你關於今日下午兩點政府職員話要登記 https://bit.ly/x', false],
  ['courier', '我係順豐職員，請查看通知 https://bit.ly/notice', true],
  ['courier-no-staff', '我係順豐快遞員，你嘅包裹 https://bit.ly/x', false],
  ['customs', '我是海关工作人员，请查看通知 https://bit.ly/notice', true],
];

describe('staff self-introductions with short links', () => {
  for (const [name, body, lure] of STAFF_CASES) {
    it(`recognises authority rather than generic staff: ${name}`, () => {
      assert.equal(analyzeScamIntent(body).impersonation, lure);
    });
    for (const context of [false, true]) {
      it(`staff handler ${name}, default context=${context}`, async () => {
        let reviews = 0;
        const archives = [];
        const env = { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' };
        if (!context) env.CONTEXT_LLM_ENABLED = '0';
        const deps = incomingDeps({
          archiveChat: async (reason) => archives.push(reason),
          blockContact: async () => assert.fail('short links must not block'),
          llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: async () => {
            reviews += 1;
            return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(
              context ? { action: 'no_action', confidence: 0.99 } : { label: 'not_scam', confidence: 0.99 },
            ) } }] }) };
          } },
        });
        deps.env = env;
        const out = await processIncomingMessage(
          { type: 'chat', body, savedContact: false, chatId: '85269993333@c.us', messageId: name }, deps,
        );
        console.log(`STAFF ${JSON.stringify({ name, context, action: out.decision.action, rule: out.heuristic?.id, reviews })}`);
        assert.equal(out.decision.action, lure ? 'archive' : 'ignore');
        assert.deepEqual(archives, lure ? ['obvious_scam'] : []);
        if (body) assert.equal(reviews, lure ? 0 : 1);
        if (lure) assert.equal(out.heuristic.id, 'short_link_solicit');
      });
    }
  }
  it('does not archive a generic staff introduction when masking fails', async () => {
    const out = await processIncomingMessage(
      { type: 'chat', body: STAFF_CASES[0][1], savedContact: false, chatId: '85269994444@c.us' },
      incomingDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
        maskClient: { async maskMessages() { throw new Error('mask unavailable'); } },
        archiveChat: async () => assert.fail('must not archive'),
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.llmTrigger.skipped, 'mask_failed');
  });
});

const ENGLISH_ADVICE = [
  "Send feedback, don't share OTP with me",
  'Never send me your OTP',
  "Don't send me your OTP",
  'Do not send me your OTP',
  "We won't ask you to send us your OTP",
  "I won't ask you to send me your OTP",
  'No one will ask you to send me your OTP',
  'Don’t send me your OTP',
];

const UNRELATED_OTP_REPLY =
  '您的驗證碼是123456。請回覆是否出席理財講座，詳情 https://bit.ly/bank-event';
const OFFER_CASES = [
  [UNRELATED_OTP_REPLY, false],
  ['請回覆以下資料：\n1. 驗證碼\n2. 電話 https://bit.ly/otp', true],
  ...['。', '！', '？', '!', '?', '；', ';'].flatMap(
    (stop) => [
      [`您的驗證碼是123456${stop}請回覆是否出席 https://bit.ly/bank-event`, false],
      [`請回覆是否出席${stop}您的驗證碼是123456 https://bit.ly/bank-event`, false],
    ],
  ),
  ...['\r\n', '\n', '\r', '\u2028', '\u2029', '\u0085'].map(
    (lineBreak) => [`請回覆以下資料：${lineBreak}1. 驗證碼${lineBreak}2. 身份證號碼 https://bit.ly/x`, true],
  ),
  ['收到驗證碼後，請回覆 https://bit.ly/otp', true],
  ['收到驗證碼後,請提供 https://bit.ly/otp', true],
  ['請提供你收到的驗證碼 https://bit.ly/otp', true],
  ['請回覆，你收到的驗證碼 https://bit.ly/otp', true],
  ['請回复,你收到的驗證碼 https://bit.ly/otp', true],
  ['銀行職員唔會叫你提供驗證碼 https://bit.ly/otp', false],
];

describe('offer verbs bind OTP within one sentence', () => {
  for (const [body, expected] of OFFER_CASES) {
    it(`offer sentence unit: ${JSON.stringify(body)}`, () => {
      assert.equal(hasOtpForwardAsk(body), expected);
    });
    for (const savedContact of [true, false]) {
      it(`offer sentence handler saved=${savedContact}: ${JSON.stringify(body)}`, async () => {
        let reviews = 0;
        const archives = [];
        const benign = notScamLlmFetch({ action: 'no_action' });
        const out = await processIncomingMessage({
          type: 'chat', body, savedContact, chatId: '85269990003@c.us',
        }, incomingDeps({
          env: {
            CONTEXT_LLM_ENABLED: '1', LLM_REVIEW_MIN_CONFIDENCE: '0.7',
            LLM_REVIEW_COOLDOWN_MS: '0', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
          },
          recentContext: createRecentContext(),
          llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: async (...args) => {
            reviews += 1;
            return benign(...args);
          } },
          archiveChat: async (reason) => archives.push(reason),
          blockContact: async () => assert.fail('OTP must not block'),
        }));
        assert.equal(out.decision.action, expected ? 'archive' : 'ignore');
        assert.equal(out.heuristic.id, expected ? 'short_link_solicit' : null);
        assert.deepEqual(archives, expected ? ['obvious_scam'] : []);
        assert.equal(reviews, expected ? 0 : 1);
      });
    }
  }
});
const ENGLISH_SCAMS = [
  'Send me your OTP',
  "Don't hesitate to send me your OTP",
  'Never mind, send me your OTP',
  'Never send anyone your OTP. Send me your OTP',
  'Never\nsend me your OTP',
];

describe('English OTP advice and solicitations', () => {
  it('English negation barriers stop direct harvest without dropping later requests', () => {
    assert.equal(hasOtpForwardAsk("Send feedback, don't share OTP with me"), false);
    assert.equal(hasOtpForwardAsk('Never share OTP. Send me your OTP'), true);
    assert.equal(hasMoneyTransferAsk('Never share OTP. 請轉帳到我的戶口'), true);
  });
  it('English intent helpers preserve multi-line scam detection', () => {
    assert.equal(hasOtpForwardAsk('Send me\nyour OTP'), false);
    assert.equal(hasMoneyTransferAsk('轉帳\n戶口 FPS'), true);
    assert.equal(matchObviousScam('轉帳\n戶口 FPS https://bit.ly/otp').id, 'short_link_solicit');
  });
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

const DIRECT_HARVEST_CASES = [
  ['send 相片畀我。今日改咗密碼。 https://bit.ly/photo', false],
  ...['！', '？', '!', '?', '\n', '\r', '\u2028', '\u2029', '\u0085', '，', ',', ';', '；', '.'].map(
    (stop) => [`send 相片畀我${stop}今日改咗密碼 https://bit.ly/photo`, false],
  ),
  ['密碼已改好。send 相片畀我 https://bit.ly/photo', false],
  [`send 相片畀我${'相'.repeat(25)}密碼 https://bit.ly/photo`, false],
  [`一次性密碼${'相'.repeat(22)}send 畀我 https://bit.ly/x`, true],
  ['send 你個密碼畀我 https://bit.ly/x', true],
  ['將驗證碼發給我 https://bit.ly/x', true],
  ['send me your OTP https://bit.ly/x', true],
  ['send me your WhatsApp verification code https://bit.ly/x', true],
  ['轉發驗證碼 bit.ly/x', true],
  ['請提供你的網上銀行密碼 https://bit.ly/x', true],
  ['', false],
];

describe('direct harvest credential binding', () => {
  it('fails closed when masking an unrelated credential short link fails', async () => {
    const out = await processIncomingMessage(
      { type: 'chat', body: DIRECT_HARVEST_CASES[0][0], chatId: '85269990002@c.us', savedContact: false },
      incomingDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
        maskClient: { async maskMessages() { throw new Error('mask unavailable'); } },
        llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: async () => assert.fail('must not call LLM') },
        archiveChat: async () => assert.fail('must not archive'),
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.llmTrigger.skipped, 'mask_failed');
  });

  for (const [body, expected] of DIRECT_HARVEST_CASES) {
    it(`binds direct harvest to a nearby same-clause credential: ${JSON.stringify(body)}`, () => {
      assert.equal(hasOtpForwardAsk(body), expected);
      assert.equal(analyzeScamIntent(body).otpForwardAsk, expected);
    });

    it(`routes short-link harvest through the real handler: ${JSON.stringify(body)}`, async () => {
      let masks = 0;
      const reasons = [];
      const out = await processIncomingMessage(
        { type: 'chat', body, chatId: '85269990001@c.us', savedContact: false, messageId: body },
        incomingDeps({
          env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
          maskClient: { async maskMessages(messages) {
            masks += 1;
            return createStubJevlikeClient('benign').maskMessages(messages);
          } },
          archiveChat: async (reason) => reasons.push(reason),
          blockContact: async () => assert.fail('must not block'),
        }),
      );
      console.log(`HARVEST ${JSON.stringify({ body, action: out.decision.action, masks })}`);
      assert.equal(out.decision.action, expected ? 'archive' : 'ignore');
      assert.deepEqual(reasons, expected ? ['obvious_scam'] : []);
      assert.equal(masks, expected ? 0 : 1);
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
