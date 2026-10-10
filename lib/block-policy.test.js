'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyBlockPolicy, contactNameForBlock } = require('./block-policy');
const { appendBlockRecord } = require('./block-log');
const { blockAndRename } = require('./wa-actions');
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

describe('block policy', () => {
  it('archives a hardcoded phrase and does not block', () => {
    const decision = applyBlockPolicy(
      { action: 'archive', archiveReason: 'jevlike_score' },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 96, label: 'scam' }),
        heuristic: { hit: true, id: 'otp_harvest', archiveReason: 'obvious_scam' },
      },
    );
    assert.equal(decision.action, 'archive');
    assert.equal(decision.blockReason, undefined);
    assert.equal(decision.contactName, undefined);
    assert.equal(
      contactNameForBlock({ blockReason: 'obvious_scam', heuristicId: 'otp_harvest' }),
      '封鎖·索取驗證碼',
    );
  });

  it('archives a high score and does not block on the score alone', () => {
    const decision = applyBlockPolicy(
      { action: 'archive', archiveReason: 'jevlike_score' },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 96, label: 'scam' }),
        heuristic: { hit: false },
      },
    );
    assert.equal(decision.action, 'archive');
    assert.equal(decision.blockReason, undefined);
  });

  it('archives grey scores and never blocks saved contacts', () => {
    const grey = applyBlockPolicy(
      { action: 'archive', archiveReason: 'jevlike_score' },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 50, label: 'scam' }),
        heuristic: { hit: false },
      },
    );
    assert.equal(grey.action, 'archive');

    const saved = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: true,
        scoreResult: scoreResult({ score: 99, label: 'scam' }),
        heuristic: { hit: true, id: 'sf_customs_link' },
      },
    );
    assert.equal(saved.action, 'archive');
    assert.equal(saved.contactName, undefined);
  });

  it('does not block when the scorer failed or the decision was released', () => {
    const unknown = applyBlockPolicy(
      { action: 'ignore', archiveReason: null },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 0, label: 'unknown', ok: false }),
        heuristic: { hit: false },
      },
    );
    assert.equal(unknown.action, 'ignore');

    const released = applyBlockPolicy(
      { action: 'ignore', archiveReason: null, released: true },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 96, label: 'scam' }),
        heuristic: { hit: false },
      },
    );
    assert.equal(released.action, 'ignore');
  });

  it('BLOCK_ENABLED=false keeps archive-only', () => {
    const decision = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 4, label: 'not_scam' }),
        heuristic: { hit: true, id: 'wa_official_ban' },
        env: { BLOCK_ENABLED: 'false' },
      },
    );
    assert.equal(decision.action, 'archive');
  });
});

describe('block log', () => {
  it('appends one JSON record', () => {
    const file = path.join(os.tmpdir(), `blocks-${process.pid}.jsonl`);
    try {
      appendBlockRecord(
        {
          at: '2026-09-21T00:00:00.000Z',
          digits: '85261234567',
          score: 96,
          blockReason: 'jevlike_score',
          contactName: '封鎖·高分96',
        },
        file,
      );
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const row = JSON.parse(lines[0]);
      assert.equal(row.digits, '85261234567');
      assert.equal(row.score, 96);
      assert.equal(row.contactName, '封鎖·高分96');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('blockAndRename', () => {
  it('blocks, then writes the reason onto the contact, then mutes', async () => {
    const calls = [];
    const result = await blockAndRename({
      client: {
        async saveOrEditAddressbookContact(phone, first, last) {
          calls.push(['rename', phone, first, last]);
        },
      },
      contact: {
        async block() {
          calls.push(['block']);
        },
      },
      chat: {
        async mute() {
          calls.push(['mute']);
        },
      },
      digits: '+852 6123 4567',
      contactName: '封鎖·轉數快即轉',
    });
    assert.deepEqual(calls, [
      ['block'],
      ['rename', '85261234567', '封鎖·轉數快即轉', ''],
      ['mute'],
    ]);
    assert.equal(result.renamed, true);
    assert.equal(result.blocked, true);
    assert.equal(result.muted, true);
  });

  it('still blocks when the rename fails or there is no phone number', async () => {
    let blocked = 0;
    const renamed = await blockAndRename({
      client: {
        async saveOrEditAddressbookContact() {
          throw new Error('addressbook down');
        },
      },
      contact: {
        async block() {
          blocked += 1;
        },
      },
      chat: { async mute() {} },
      digits: '85260000000',
      contactName: '封鎖·高分90',
    });
    assert.equal(blocked, 1);
    assert.equal(renamed.renamed, false);
    assert.equal(renamed.blocked, true);
    assert.match(renamed.errors[0], /addressbook down/);

    const noPhone = await blockAndRename({
      contact: {
        async block() {
          blocked += 1;
        },
      },
      digits: null,
      contactName: '封鎖·高分90',
    });
    assert.equal(blocked, 2);
    assert.deepEqual(noPhone.errors, ['rename:no_phone']);
  });

  it('does not save the contact when block throws', async () => {
    let renamed = 0;
    await assert.rejects(
      () =>
        blockAndRename({
          client: {
            async saveOrEditAddressbookContact() {
              renamed += 1;
            },
          },
          contact: {
            async block() {
              throw new Error('block down');
            },
          },
          digits: '85260000000',
          contactName: '封鎖·高分90',
        }),
      /block down/,
    );
    assert.equal(renamed, 0);
  });
});

describe('processIncomingMessage block actions', () => {
  const records = [];

  it('archives an unsaved high score without blocking', async () => {
    const actions = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 請睇下',
        chatId: '85269990000@c.us',
        savedContact: false,
        pushName: '陌生',
        messageId: 'block-score',
      },
      {
        scoreClient: createStubJevlikeClient(),
        rubric,
        resolveNumber: async () => ({
          digits: '85269990000',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => actions.push(['archive', reason]),
        blockContact: async (info) => {
          actions.push(['block', info.contactName, info.digits]);
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async (record) => records.push(record),
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.deepEqual(actions, [['archive', 'jevlike_score']]);
    assert.equal(records.length, 0);
  });

  it('archives a context-model block and does not block before setup is answered', async () => {
    let blocked = false;
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請用轉數快立即轉帳到此帳戶',
        chatId: 'hold-block@c.us',
        savedContact: false,
        messageId: 'hold-block',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        holdBlock: true,
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                choices: [{ message: { content: JSON.stringify({ action: 'block', reason: 'sure' }) } }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
        resolveNumber: async () => ({
          digits: '85260001234',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.heldBlock, true);
    assert.equal(blocked, false);
    assert.deepEqual(reasons, ['context_llm']);
  });

  it('scores a hardcoded phrase instead of deciding from the words', async () => {
    let scoreCalls = 0;
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請用轉數快立即轉帳到此帳戶',
        chatId: 'fast-heur@c.us',
        savedContact: false,
        messageId: 'fast-heur',
      },
      {
        scoreClient: {
          async scoreText() {
            scoreCalls += 1;
            return { prob_scam: 0.04 };
          },
        },
        rubric,
        resolveNumber: async () => ({
          digits: '85260004321',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(scoreCalls, 1);
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.scoreSource, 'single');
    assert.equal(blocked, false);
  });

  it('does not archive an unsaved hardcoded phrase below the score threshold', async () => {
    const names = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請用轉數快立即轉帳到此帳戶',
        chatId: '14155550123@c.us',
        savedContact: false,
        messageId: 'block-heuristic',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '14155550123',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async (info) => {
          names.push(info.contactName);
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.blockReason, undefined);
    assert.deepEqual(names, []);
  });

  it('only archives a grey unsaved score', async () => {
    let blocked = false;
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'hello there',
        chatId: '85260000001@c.us',
        savedContact: false,
        messageId: 'grey-unsaved',
      },
      {
        scoreClient: createStubJevlikeClient(0.55),
        rubric,
        resolveNumber: async () => ({
          digits: '85260000001',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
        blockContact: async () => {
          blocked = true;
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blocked, false);
    assert.deepEqual(reasons, ['jevlike_score']);
  });

  it('does not block a saved contact even on a high score', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 請睇下',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'saved-high',
      },
      {
        scoreClient: createStubJevlikeClient(),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
        },
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blocked, false);
  });

  it('does not block when the LLM releases a high score', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚食飯我之後PayMe返你，唔使急',
        chatId: '85261234567@c.us',
        savedContact: false,
        messageId: 'llm-release-unsaved',
      },
      {
        env: { LLM_REVIEW_ENABLED: 'true' },
        scoreClient: createStubJevlikeClient(0.92),
        rubric,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        label: 'not_scam',
                        confidence: 0.8,
                        signals: [],
                        should_archive: false,
                        reason: 'friend',
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.released, true);
    assert.equal(blocked, false);
  });

  it('archives a hardcoded phrase without calling block', async () => {
    const logged = [];
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請把驗證碼發給我',
        chatId: '85260000002@c.us',
        savedContact: false,
        messageId: 'no-word-block',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '85260000002',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          throw new Error('block rejected');
        },
        recordBlock: async (record) => logged.push(record),
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.archiveReason, null);
    assert.equal(blocked, false);
    assert.equal(logged.length, 0);
  });
});
