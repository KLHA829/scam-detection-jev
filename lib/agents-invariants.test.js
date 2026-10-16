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

function llmJson(action) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action, reason: 'invariant' }) } }],
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

  it('invariant: unsaved current-message link rule (lookalike host) may block', () => {
    const eligibility = blockEligibility({
      savedContact: false,
      scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
      heuristic: { hit: true, id: 'lookalike_domain', archiveReason: 'obvious_scam' },
    });
    assert.equal(eligibility.blockReason, 'obvious_scam');
    assert.equal(eligibility.contactName, '封鎖·假域名');
  });

  it('invariant: unsaved explicit context-model block may block', () => {
    const eligibility = blockEligibility({
      savedContact: false,
      scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
      heuristic: { hit: false },
      contextLlmBlock: true,
    });
    assert.equal(eligibility.blockReason, 'context_llm');
    assert.equal(eligibility.contactName, '封鎖·上文覆核');
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

describe('AGENTS.md invariants — fail-closed scorer (decideIncomingAction)', () => {
  it('invariant: scorer unknown alone never archives', () => {
    const unknown = scoreResult({ score: 50, label: 'unknown', ok: false });
    assert.deepEqual(
      decideIncomingAction(unknown, '85261234567', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('invariant: scorer unknown with block-line numeric score still ignores (fail closed)', () => {
    const blockLine = resolveBlockThreshold({ rubric });
    const failedHigh = scoreResult({
      score: blockLine + 10,
      label: 'unknown',
      ok: false,
    });
    assert.deepEqual(
      decideIncomingAction(failedHigh, '14155550123', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });
});

describe('AGENTS.md invariants — processIncomingMessage integration', () => {
  it('invariant: scorer failure alone never archives in the live decision path', async () => {
    const archives = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'plain hello',
        chatId: '85269998888@c.us',
        savedContact: false,
        messageId: 'agents-unknown',
      },
      {
        scoreClient: {
          async scoreText() {
            throw new Error('jevlike 503');
          },
        },
        rubric,
        resolveNumber: async () => ({ digits: '85269998888', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          throw new Error('must not block');
        },
      },
    );
    assert.equal(out.scoreResult.ok, false);
    assert.equal(out.scoreResult.label, 'unknown');
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(archives, []);
  });

  it('invariant: unsaved block-line stub score archives and never calls blockContact', async () => {
    const archives = [];
    let blockCalls = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 高分但無連結',
        chatId: '85269997777@c.us',
        savedContact: false,
        messageId: 'agents-score-no-block',
      },
      {
        scoreClient: createStubJevlikeClient(),
        rubric,
        resolveNumber: async () => ({ digits: '85269997777', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          blockCalls += 1;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.equal(blockCalls, 0);
    assert.deepEqual(archives, ['jevlike_score']);
  });

  it('invariant: saved contact at block-line score archives without blockContact', async () => {
    let blockCalls = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 已儲存聯絡人',
        chatId: '85261230000@c.us',
        savedContact: true,
        messageId: 'agents-saved-no-block',
      },
      {
        scoreClient: createStubJevlikeClient(),
        rubric,
        resolveNumber: async () => ({ digits: '85261230000', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blockCalls += 1;
        },
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blockCalls, 0);
  });

  it('invariant: unsaved context-model block is a permitted auto-block path', async () => {
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
        scoreClient: createStubJevlikeClient('benign'),
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
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'context_llm');
    assert.equal(blocked, true);
  });

  it('invariant: unsaved current-message lookalike link rule blocks without waiting on score', async () => {
    let scoreCalls = 0;
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: '85269995555@c.us',
        savedContact: false,
        messageId: 'agents-link-block',
      },
      {
        scoreClient: {
          async scoreText() {
            scoreCalls += 1;
            return new Promise(() => {});
          },
        },
        rubric,
        resolveNumber: async () => ({ digits: '85269995555', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async (info) => {
          blocked = info.contactName;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(scoreCalls, 0);
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'obvious_scam');
    assert.equal(blocked, '封鎖·假域名');
  });
});
