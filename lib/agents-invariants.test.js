'use strict';

/**
 * Offline locks for AGENTS.md decision invariants (block vs archive, fail-closed scorer).
 * Thresholds come from scoring-rubric.json — do not hard-code different cutoffs here.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decideIncomingAction } = require('./decide-incoming');
const {
  applyBlockPolicy,
  blockEligibility,
  resolveBlockThreshold,
} = require('./block-policy');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

function scoreResult(overrides = {}) {
  return {
    score: 0,
    label: 'not_scam',
    ok: true,
    thresholds: rubric.thresholds,
    ...overrides,
  };
}

function llmJson(action, confidence = 0.9) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ action, confidence, reason: 'invariant' }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('AGENTS.md invariants — block eligibility', () => {
  const blockLine = resolveBlockThreshold({ rubric });

  it('invariant: saved contacts are never auto-blocked (blockEligibility stays null)', () => {
    assert.equal(
      blockEligibility({
        savedContact: true,
        scoreResult: scoreResult({ score: blockLine + 5, label: 'scam' }),
        heuristic: { hit: true, id: 'lookalike_domain' },
      }),
      null,
    );
  });

  it('invariant: unsaved jevlike score at or above BLOCK_THRESHOLD alone does not block', () => {
    for (const score of [blockLine, blockLine + 15, 99]) {
      assert.equal(
        blockEligibility({
          savedContact: false,
          scoreResult: scoreResult({ score, label: 'scam' }),
          heuristic: { hit: false },
        }),
        null,
      );
    }
  });

  it('invariant: unsaved lookalike link rule does not auto-block (archive only)', () => {
    assert.equal(
      blockEligibility({
        savedContact: false,
        scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
        heuristic: { hit: true, id: 'lookalike_domain', archiveReason: 'obvious_scam' },
      }),
      null,
    );
  });

  it('invariant: unsaved short_link_solicit does not auto-block', () => {
    assert.equal(
      blockEligibility({
        savedContact: false,
        scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
        heuristic: { hit: true, id: 'short_link_solicit', archiveReason: 'obvious_scam' },
      }),
      null,
    );
  });

  it('invariant: unsaved malicious_host on the current message may block', () => {
    const eligibility = blockEligibility({
      savedContact: false,
      scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
      heuristic: { hit: true, id: 'malicious_host', archiveReason: 'obvious_scam' },
    });
    assert.equal(eligibility.blockReason, 'malicious_host');
    assert.equal(eligibility.contactName, '封鎖·惡意域名');
  });

  it('invariant: applyBlockPolicy archives saved contacts even with link heuristic on current message', () => {
    const primary = { action: 'archive', archiveReason: 'obvious_scam' };
    const after = applyBlockPolicy(primary, {
      savedContact: true,
      scoreResult: scoreResult({ score: 99, label: 'scam' }),
      heuristic: { hit: true, id: 'lookalike_domain' },
    });
    assert.equal(after.action, 'archive');
    assert.equal(after.contactName, undefined);
  });

  it('invariant: applyBlockPolicy archives unsaved block-line score without link rule or context block', () => {
    const primary = { action: 'archive', archiveReason: 'jevlike_score' };
    const after = applyBlockPolicy(primary, {
      savedContact: false,
      scoreResult: scoreResult({ score: blockLine, label: 'scam' }),
      heuristic: { hit: false },
    });
    assert.equal(after.action, 'archive');
    assert.equal(after.blockReason, undefined);
  });

  it('invariant: scorer unknown (ok:false) never promotes to block via applyBlockPolicy', () => {
    const after = applyBlockPolicy(
      { action: 'ignore', archiveReason: null },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 99, label: 'unknown', ok: false }),
        heuristic: { hit: false },
      },
    );
    assert.equal(after.action, 'ignore');
  });
});

describe('AGENTS.md invariants — primary decide (heuristic only)', () => {
  it('invariant: non-heuristic messages ignore before LLM merge', () => {
    assert.deepEqual(
      decideIncomingAction(null, '85261234567', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('invariant: link heuristic archives without a score', () => {
    assert.deepEqual(
      decideIncomingAction(null, '14155550123', false, {
        hit: true,
        archiveReason: 'obvious_scam',
      }),
      { action: 'archive', archiveReason: 'obvious_scam' },
    );
  });
});

describe('AGENTS.md invariants — processIncomingMessage integration', () => {
  it('invariant: mask failure alone never archives in the live decision path', async () => {
    const archives = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'plain hello',
        chatId: '85269998888@c.us',
        savedContact: false,
        messageId: 'agents-mask-fail',
      },
      {
        maskClient: {
          async maskMessages() {
            throw new Error('mask 503');
          },
        },
        rubric,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            throw new Error('must not call llm');
          },
        },
        resolveNumber: async () => ({ digits: '85269998888', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          throw new Error('must not block');
        },
      },
    );
    assert.equal(out.llmTrigger.skipped, 'mask_failed');
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(archives, []);
  });

  it('invariant: LLM scam archives unsaved contact and never calls blockContact', async () => {
    const archives = [];
    let blockCalls = 0;
    const { primaryPathDeps, scamLlmFetch } = require('./test-llm');
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即轉帳到這個戶口',
        chatId: '85269997777@c.us',
        savedContact: false,
        messageId: 'agents-llm-no-block',
      },
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
        resolveNumber: async () => ({ digits: '85269997777', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          blockCalls += 1;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.equal(blockCalls, 0);
    assert.deepEqual(archives, ['llm_review_scam']);
  });

  it('invariant: saved contact LLM archive does not call blockContact', async () => {
    let blockCalls = 0;
    const { primaryPathDeps, scamLlmFetch } = require('./test-llm');
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即轉帳',
        chatId: '85261230000@c.us',
        savedContact: true,
        messageId: 'agents-saved-no-block',
      },
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
        resolveNumber: async () => ({ digits: '85261230000', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blockCalls += 1;
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blockCalls, 0);
  });

  it('invariant: context-model block archives only and never auto-blocks', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請回覆確認',
        chatId: '85269996666@c.us',
        savedContact: false,
        messageId: 'agents-ctx-block',
      },
      {
        maskClient: createStubJevlikeClient('benign'),
        rubric,
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmJson('block'),
        },
        resolveNumber: async () => ({ digits: '85269996666', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'context_llm');
    assert.equal(blocked, false);
  });

  it('invariant: unsaved lookalike archives without waiting on score and does not block', async () => {
    let scoreCalls = 0;
    let blocked = false;
    const archives = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: '85269995555@c.us',
        savedContact: false,
        messageId: 'agents-link-block',
      },
      {
        maskClient: {
          async scoreText() {
            scoreCalls += 1;
            return new Promise(() => {});
          },
          async maskMessages(messages) {
            return createStubJevlikeClient().maskMessages(messages);
          },
        },
        llmReview: { enabled: false },
        rubric,
        resolveNumber: async () => ({ digits: '85269995555', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(scoreCalls, 0);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'obvious_scam');
    assert.equal(blocked, false);
    assert.deepEqual(archives, ['obvious_scam']);
  });
});

describe('AGENTS.md invariants — defensive gauntlet', () => {
  const FIXTURE_PHONE = '90001122';
  const FIXTURE_BODY = `FIXTURE_CONTACT_LABEL 電話${FIXTURE_PHONE}`;

  const linkHardArchiveCases = [
    {
      id: 'lookalike_domain',
      body: '登入 https://whatsapp-secure.com/login',
    },
    {
      id: 'short_link_solicit',
      body: '請提供驗證碼 https://bit.ly/fee',
    },
    {
      id: 'malicious_host',
      body: '按此 https://malicious-block-test.invalid/login',
    },
  ];

  it('invariant: saved contact on malicious_host archives only (never auto-block)', async () => {
    assert.equal(
      blockEligibility({
        savedContact: true,
        scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
        heuristic: { hit: true, id: 'malicious_host', archiveReason: 'obvious_scam' },
      }),
      null,
    );

    let blockCalls = 0;
    const body = '按此 https://malicious-block-test.invalid/login';
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body,
        chatId: '85261239999@c.us',
        savedContact: true,
        messageId: 'gauntlet-saved-mal-host',
      },
      {
        maskClient: createStubJevlikeClient('benign'),
        rubric,
        llmReview: { enabled: false },
        resolveNumber: async () => ({ digits: '85261239999', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blockCalls += 1;
        },
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.blockReason, undefined);
    assert.equal(blockCalls, 0);
  });

  it('invariant: primary LLM HTTP body must not contain raw fixture phone after mask', async () => {
    let serialized = '';
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: FIXTURE_BODY,
        chatId: '85261112233@c.us',
        savedContact: true,
        messageId: 'gauntlet-pii-primary',
      },
      {
        env: { CONTEXT_LLM_ENABLED: 'false', LLM_REVIEW_ENABLED: 'true' },
        maskClient: createStubJevlikeClient('benign'),
        rubric,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            serialized = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        label: 'not_scam',
                        confidence: 0.2,
                        signals: [],
                        should_archive: false,
                        reason: 'fixture',
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
        resolveNumber: async () => ({ digits: '85261112233', unresolvedLid: false }),
        archiveChat: async () => {},
      },
    );
    assert.ok(serialized.length > 0);
    assert.equal(serialized.includes(FIXTURE_PHONE), false);
    assert.match(out.redacted, /XXX/);
    assert.equal(out.decision.action, 'ignore');
  });

  for (const { id, body } of linkHardArchiveCases) {
    it(`invariant: ${id} fast path skips primary and context LLM`, async () => {
      let primaryLlm = 0;
      let contextLlm = 0;
      let maskCalls = 0;
      const client = createStubJevlikeClient('benign');
      const origMask = client.maskMessages.bind(client);
      client.maskMessages = async (...args) => {
        maskCalls += 1;
        return origMask(...args);
      };
      const baseDeps = {
        maskClient: client,
        rubric,
        resolveNumber: async () => ({ digits: '85260000000', unresolvedLid: false }),
        archiveChat: async () => {},
      };

      const primaryOut = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: `gauntlet-primary-${id}@c.us`,
          savedContact: false,
          messageId: `gauntlet-p-${id}`,
        },
        {
          ...baseDeps,
          env: { CONTEXT_LLM_ENABLED: 'false', LLM_REVIEW_ENABLED: 'true' },
          llmReview: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            fetchImpl: async () => {
              primaryLlm += 1;
              throw new Error('primary llm must not run');
            },
          },
        },
      );
      assert.equal(primaryOut.llmTrigger.skipped, 'hard_archive');
      assert.ok(
        primaryOut.decision.action === 'archive' || primaryOut.decision.action === 'block',
      );
      assert.equal(primaryLlm, 0);
      assert.equal(maskCalls, 0);

      maskCalls = 0;
      const contextOut = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: `gauntlet-ctx-${id}@c.us`,
          savedContact: false,
          messageId: `gauntlet-c-${id}`,
        },
        {
          ...baseDeps,
          contextLlm: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            fetchImpl: async () => {
              contextLlm += 1;
              throw new Error('context llm must not run');
            },
          },
        },
      );
      assert.equal(contextOut.llmTrigger.skipped, 'hard_archive');
      assert.ok(
        contextOut.decision.action === 'archive' || contextOut.decision.action === 'block',
      );
      assert.equal(contextLlm, 0);
      assert.equal(maskCalls, 0);
    });
  }
});
