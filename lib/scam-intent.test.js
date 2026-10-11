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

  it('does not let a negated clause swallow the next ask', () => {
    const otp = '這不是詐騙，請勿告訴他人，請把驗證碼發給我';
    assert.equal(hasOtpForwardAsk(otp), true);
    assert.equal(shouldSuppress(otp), false);

    const money = '小心，不要在街上交易，請轉帳到我的戶口';
    assert.equal(hasMoneyTransferAsk(money), true);
    assert.equal(shouldSuppress(money), false);
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

  it('does not suppress a lookalike just because the copy says 詐騙', () => {
    const text = '這不是詐騙，請登入 https://whatsapp-secure.com/login';
    const out = resolveIncomingMessageLabel(
      scoreResult({ label: 'not_scam', score: 4 }),
      text,
    );
    assert.equal(out.suppressed, undefined);
    assert.equal(out.archiveReason, 'obvious_scam');
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

  it('leaves a simplified 防骗 warning that matches the official-ban regex', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '防骗：WhatsApp 官方通知，否則封號',
        chatId: '85269994444@c.us',
        savedContact: false,
        messageId: 'warn-simp',
      },
      {
        scoreClient: createStubJevlikeClient('scam'),
        rubric,
        resolveNumber: async () => ({
          digits: '85269994444',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      },
    );
    assert.equal(matchObviousScam('防骗：WhatsApp 官方通知，否則封號').hit, false);
    assert.equal(out.suppressed, true);
    assert.equal(out.decision.action, 'ignore');
    assert.equal(blocked, false);
  });

  it('does not let an earlier lure block a later pure warning', async () => {
    const { createThreadContext } = require('./thread-context');
    const thread = createThreadContext({ turns: 4 });
    let blocked = 0;
    const deps = {
      scoreClient: createStubJevlikeClient('scam'),
      rubric,
      threadContext: thread,
      resolveNumber: async () => ({ digits: '85269995555', unresolvedLid: false }),
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
        body: '請用轉數快立即轉帳到此帳戶',
        chatId: 'later-warn@c.us',
        savedContact: false,
        messageId: 'later-1',
      },
      deps,
    );
    const second = await processIncomingMessage(
      {
        type: 'chat',
        body: '小心，WhatsApp 官方封號係騙局',
        chatId: 'later-warn@c.us',
        savedContact: false,
        messageId: 'later-2',
      },
      deps,
    );
    assert.equal(second.suppressed, true);
    assert.equal(second.decision.action, 'ignore');
    assert.equal(blocked, 1);
  });

  it('leaves a pure warning that also matches the official-ban regex', async () => {
    let blocked = false;
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '小心，WhatsApp 官方封號係騙局',
        chatId: '85269992222@c.us',
        savedContact: false,
        messageId: 'warn-ban',
      },
      {
        scoreClient: createStubJevlikeClient('scam'),
        rubric,
        resolveNumber: async () => ({
          digits: '85269992222',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      },
    );
    assert.equal(out.suppressed, true);
    assert.equal(out.decision.action, 'ignore');
    assert.equal(blocked, false);
    assert.deepEqual(reasons, []);
  });

  it('still blocks a warning that also asks for a transfer', async () => {
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '小心，我係 WhatsApp 官方，你個號會被封號，請即刻轉帳到呢個戶口',
        chatId: '85269993333@c.us',
        savedContact: false,
        messageId: 'warn-pay',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '85269993333',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => ({
          renamed: true,
          blocked: true,
          muted: true,
          errors: [],
        }),
      },
    );
    assert.equal(out.suppressed, false);
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'obvious_scam');
  });

  it('still blocks an unsaved lookalike when the text says 這不是詐騙', async () => {
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '這不是詐騙，請登入 https://whatsapp-secure.com/login',
        chatId: '85269991111@c.us',
        savedContact: false,
        messageId: 'lookalike-warn',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '85269991111',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => ({
          renamed: false,
          blocked: true,
          muted: false,
          errors: [],
        }),
      },
    );
    assert.equal(out.suppressed, false);
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'obvious_scam');
  });

  it('does not block warning copy that only quotes a trope', async () => {
    const samples = [
      '警方提醒：切勿用轉數快立即轉帳俾陌生人',
      '新聞：WhatsApp官方不會以封號為由聯絡你',
      '新聞：騙徒會話你驗證碼即將過期，切勿理睬',
      '警方呼籲切勿向陌生人的 USDT wallet 轉帳',
      '新聞：警方提醒市民，騙徒會叫你提供驗證碼。',
      '你的順豐清關文件已備妥 https://www.sf-express.com/hk/track',
    ];
    for (const body of samples) {
      const out = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: '85261110000@c.us',
          savedContact: false,
          messageId: `warn-${body.length}`,
        },
        {
          scoreClient: createStubJevlikeClient('benign'),
          rubric,
          resolveNumber: async () => ({ digits: '85261110000', unresolvedLid: false }),
          archiveChat: async () => {},
          blockContact: async () => ({ blocked: true, renamed: true, muted: true, errors: [] }),
        },
      );
      assert.equal(out.decision.action, 'ignore', body);
    }
  });

  it('still blocks a real 轉數快 lure and a non-official customs link', async () => {
    const customs = await processIncomingMessage(
      {
        type: 'chat',
        body: '你的順豐清關文件 https://evil.example/pay',
        chatId: '85261110001@c.us',
        savedContact: false,
        messageId: 'sf-evil',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({ digits: '85261110001', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => ({ blocked: true, renamed: true, muted: true, errors: [] }),
      },
    );
    assert.equal(customs.decision.action, 'block');
    assert.equal(customs.heuristic.id, 'sf_customs_link');
    assert.equal(matchObviousScam('轉數快立即轉帳俾我').id, 'fps_urgent_transfer');
  });

  it('keeps an OTP ask that has no comma after the warning', () => {
    const otp = '這不是詐騙請勿告訴他人請把驗證碼發給我';
    assert.equal(hasOtpForwardAsk(otp), true);
    assert.equal(shouldSuppress(otp), false);
    assert.equal(matchObviousScam(otp).hit, true);

    const money = '小心詐騙，請特別轉帳到此戶口';
    assert.equal(hasMoneyTransferAsk(money), true);
    assert.equal(shouldSuppress(money), false);

    const ident = '請識別驗證碼後發給我';
    assert.equal(hasOtpForwardAsk(ident), true);
    assert.equal(matchObviousScam(ident).id, 'otp_harvest');
  });

  it('does not treat a promo code as a WhatsApp OTP', async () => {
    const promo = '投資回報日日有，優惠 code: VIP88，快啲登記';
    const { hasSelfOtpLanguage } = require('./scam-intent');
    assert.equal(hasSelfOtpLanguage(promo), false);
    assert.equal(shouldSuppress(promo), false);
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: promo,
        chatId: '85261110002@c.us',
        savedContact: true,
        messageId: 'promo-code',
      },
      {
        scoreClient: createStubJevlikeClient(0.7),
        rubric,
        resolveNumber: async () => ({ digits: '85261110002', unresolvedLid: false }),
        archiveChat: async () => {},
      },
    );
    assert.equal(out.suppressed, false);
    assert.equal(out.decision.action, 'archive');
  });
});
