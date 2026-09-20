'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { foldTraditionalToSimplified, normalizeForMatch } = require('./cjk-fold');
const { matchObviousScam } = require('./heuristics');
const { matchRagScam, loadCorpus, clearCorpusCache, extractTags } = require('./rag');
const { decideIncomingAction, resolveIncomingMessageLabel } = require('./decide-incoming');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubClient } = require('../stub-openjev');

const rubric = loadRubric();
const CORPUS_PATH = path.join(__dirname, '..', 'data', 'scam-examples-zh-yue.jsonl');
const CORPUS = fs
  .readFileSync(CORPUS_PATH, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const HEURISTIC_OFF = { HEURISTIC_ENABLED: 'false' };
const RAG_OFF = { RAG_ENABLED: 'false' };

function scoreResult(overrides = {}) {
  return {
    score: 0,
    label: 'not_scam',
    ok: true,
    thresholds: rubric.thresholds,
    ...overrides,
  };
}

describe('cjk fold', () => {
  it('folds HK traditional scam tokens to simplified', () => {
    assert.equal(foldTraditionalToSimplified('驗證碼'), '验证码');
    assert.equal(foldTraditionalToSimplified('轉數快'), '转数快');
    assert.equal(foldTraditionalToSimplified('帳戶'), '账户');
    assert.equal(foldTraditionalToSimplified('保證金'), '保证金');
    assert.equal(foldTraditionalToSimplified('清關'), '清关');
    assert.match(normalizeForMatch('請用轉數快立即轉帳'), /转数快/);
    assert.match(normalizeForMatch('請用轉數快立即轉帳'), /转账/);
  });
});

describe('zh/yue heuristics', () => {
  it('catches previously failing tropes', () => {
    assert.equal(
      matchObviousScam('老板先把USDT打到这个钱包').id,
      'usdt_wallet_send',
    );
    assert.ok(
      matchObviousScam('用轉數快即刻過嚟，再send OTP畀我').hit,
    );
    assert.ok(matchObviousScam('我是公安，把验证码发给我').hit);
    assert.ok(
      matchObviousScam('【中国银行】请点击链接并提供验证码 http://example.test/x')
        .hit,
    );
  });

  it('still matches the original tight cases', () => {
    assert.equal(matchObviousScam('您的驗證碼即將過期，請立即回覆').hit, true);
    assert.equal(
      matchObviousScam('請用轉數快立即轉帳到此帳戶').id,
      'fps_urgent_transfer',
    );
    assert.equal(
      matchObviousScam('WhatsApp 官方通知：否則封號').id,
      'wa_official_ban',
    );
    assert.equal(
      matchObviousScam('Send USDT to this wallet address now').id,
      'usdt_wallet_send',
    );
    assert.equal(
      matchObviousScam('順豐包裹清關費 http://bit.ly/x').id,
      'sf_customs_link',
    );
  });

  it('does not fire on benign lunch / thanks', () => {
    assert.equal(matchObviousScam('今晚食飯嗎？我轉帳比你 AA').hit, false);
    assert.equal(matchObviousScam('中午一起吃饭吧，谢谢').hit, false);
    assert.equal(matchObviousScam('多謝你幫手').hit, false);
    assert.equal(matchObviousScam('ok thanks').hit, false);
    assert.equal(matchObviousScam('我收唔到驗證碼，等陣再試').hit, false);
  });
});

describe('zh/yue RAG matcher', () => {
  it('loads the shipped corpus without network', () => {
    clearCorpusCache();
    const examples = loadCorpus({ RAG_CORPUS_PATH: CORPUS_PATH });
    assert.equal(examples.length, CORPUS.length);
    assert.ok(examples.length >= 10);
  });

  it('matches each corpus example to itself', () => {
    for (const row of CORPUS) {
      const rag = matchRagScam(row.text, HEURISTIC_OFF);
      assert.equal(rag.hit, true, `${row.id} should RAG-match`);
      assert.equal(rag.id, row.id, `${row.id} nearest should be itself`);
      assert.equal(rag.archiveReason, 'rag_scam_match');
    }
  });

  it('does not archive benign CN/HK chat', () => {
    assert.equal(matchRagScam('今晚食飯嗎？我轉帳比你 AA').hit, false);
    assert.equal(matchRagScam('中午一起吃饭吧，谢谢').hit, false);
    assert.equal(matchRagScam('多謝你幫手買午餐').hit, false);
    assert.equal(matchRagScam('ok thanks').hit, false);
  });

  it('can be disabled via env', () => {
    const row = CORPUS.find((x) => x.id === 'cn_usdt_rebate');
    assert.equal(matchRagScam(row.text, RAG_OFF).hit, false);
  });

  it('extracts overlapping tropes as tags', () => {
    const tags = extractTags('公安要验证码，转数快打到这个钱包');
    assert.ok(tags.has('otp_harvest'));
    assert.ok(tags.has('fps'));
    assert.ok(tags.has('impersonation_authority'));
  });
});

describe('corpus examples archive via heuristic and/or RAG', () => {
  for (const row of CORPUS) {
    it(`archives ${row.id} (${row.lang})`, () => {
      const heuristic = matchObviousScam(row.text);
      const rag = matchRagScam(row.text);
      assert.ok(
        heuristic.hit || rag.hit,
        `${row.id} missed both heuristic and RAG: ${row.text}`,
      );
      const decision = decideIncomingAction(
        scoreResult({ score: 4, label: 'not_scam' }),
        '85261234567',
        true,
        heuristic,
        rag,
      );
      assert.equal(decision.action, 'archive');
      assert.ok(
        decision.archiveReason === 'obvious_scam' ||
          decision.archiveReason === 'rag_scam_match',
      );
      assert.notEqual(decision.action, 'block');
    });
  }
});

describe('decideIncomingAction RAG path', () => {
  it('archives rag_scam_match when heuristics miss and score is low', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: false }, {
        hit: true,
        archiveReason: 'rag_scam_match',
        id: 'cn_usdt_rebate',
      }),
      { action: 'archive', archiveReason: 'rag_scam_match' },
    );
  });

  it('prefers heuristic over RAG', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(
        low,
        '85261234567',
        true,
        { hit: true, archiveReason: 'obvious_scam' },
        { hit: true, archiveReason: 'rag_scam_match' },
      ),
      { action: 'archive', archiveReason: 'obvious_scam' },
    );
  });
});

describe('resolveIncomingMessageLabel zh/yue', () => {
  it('promotes RAG-only hits to scam', () => {
    const out = resolveIncomingMessageLabel(
      scoreResult({ label: 'not_scam', score: 2 }),
      CORPUS.find((x) => x.id === 'zh_romance_crypto').text,
      { HEURISTIC_ENABLED: 'false' },
    );
    assert.equal(out.label, 'scam');
    assert.equal(out.archiveReason, 'rag_scam_match');
    assert.equal(out.rag.id, 'zh_romance_crypto');
  });
});

describe('processIncomingMessage zh/yue with stub OpenJEV', () => {
  it('archives CN/HK scam copy even when the stub scores benign', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '老板先把USDT打到这个钱包，马上给你返利，验证码也发我。',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'zh1',
      },
      {
        scoreClient: createStubClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.scoreResult.label, 'not_scam');
    assert.equal(out.decision.action, 'archive');
    assert.ok(
      out.decision.archiveReason === 'obvious_scam' ||
        out.decision.archiveReason === 'rag_scam_match',
    );
    assert.ok(reasons.length === 1);
    assert.notEqual(out.decision.action, 'block');
  });

  it('ignores benign lunch / thanks with stub scores', async () => {
    for (const body of ['今晚食飯嗎？我轉帳比你 AA', '中午一起吃饭吧，谢谢']) {
      const reasons = [];
      const out = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: '85261234567@c.us',
          savedContact: true,
          messageId: `benign-${body.length}`,
        },
        {
          scoreClient: createStubClient('benign'),
          rubric,
          resolveNumber: async () => ({
            digits: '85261234567',
            unresolvedLid: false,
          }),
          archiveChat: async (reason) => reasons.push(reason),
        },
      );
      assert.equal(out.decision.action, 'ignore', body);
      assert.deepEqual(reasons, []);
    }
  });
});
