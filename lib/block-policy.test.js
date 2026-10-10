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
  it('names the contact after the heuristic, preferring it over a high score', () => {
    const decision = applyBlockPolicy(
      { action: 'archive', archiveReason: 'jevlike_score' },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 96, label: 'scam' }),
        heuristic: { hit: true, id: 'otp_harvest', archiveReason: 'obvious_scam' },
      },
    );
    assert.equal(decision.action, 'block');
    assert.equal(decision.blockReason, 'obvious_scam');
    assert.equal(decision.contactName, '封鎖·索取驗證碼');
    assert.equal(
      contactNameForBlock({ blockReason: 'jevlike_score', score: 91.2 }),
      '封鎖·高分91',
    );
  });

  it('blocks an unsaved contact at or above BLOCK_THRESHOLD', () => {
    const decision = applyBlockPolicy(
      { action: 'archive', archiveReason: 'jevlike_score' },
      {
        savedContact: false,
        scoreResult: scoreResult({ score: 80, label: 'scam' }),
        heuristic: { hit: false },
      },
    );
    assert.equal(decision.action, 'block');
    assert.equal(decision.blockReason, 'jevlike_score');
    assert.equal(decision.contactName, '封鎖·高分80');
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

  it('blocks an unsaved high score, renames, and logs', async () => {
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
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.contactName, '封鎖·高分96');
    assert.deepEqual(actions, [
      ['block', '封鎖·高分96', '85269990000'],
      ['archive', 'jevlike_score'],
    ]);
    assert.equal(records[0].digits, '85269990000');
    assert.equal(records[0].pushName, '陌生');
    assert.equal(records[0].blocked, true);
    assert.equal(records[0].score, 96);
  });

  it('blocks an unsaved obvious scam below the score threshold', async () => {
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
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'obvious_scam');
    assert.deepEqual(names, ['封鎖·轉數快即轉']);
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

  it('still archives when block throws, and records the failure', async () => {
    const logged = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請把驗證碼發給我',
        chatId: '85260000002@c.us',
        savedContact: false,
        messageId: 'block-throws',
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
          throw new Error('block rejected');
        },
        recordBlock: async (record) => logged.push(record),
      },
    );
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.contactName, '封鎖·索取驗證碼');
    assert.equal(logged[0].blocked, false);
    assert.equal(logged[0].archived, true);
    assert.match(logged[0].errors[0], /block rejected/);
  });
});
