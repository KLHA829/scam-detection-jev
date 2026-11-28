'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyBlockPolicy,
  contactNameForBlock,
  isOperatorSavedContact,
  isUnsavedContact,
  SUSPICIOUS_PITCH_CONTACT_NAME,
} = require('./block-policy');
const { createBotContactNames } = require('./bot-contact-names');
const { appendBlockRecord } = require('./block-log');
const { blockAndRename } = require('./wa-actions');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');

describe('block policy', () => {
  it('blocks only on malicious_host, not lookalike heuristics', () => {
    const lookalike = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: false,
        heuristic: { hit: true, id: 'lookalike_domain', archiveReason: 'obvious_scam' },
      },
    );
    assert.equal(lookalike.action, 'archive');

    const malicious = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: false,
        heuristic: { hit: true, id: 'malicious_host', archiveReason: 'obvious_scam' },
      },
    );
    assert.equal(malicious.action, 'block');
    assert.equal(malicious.blockReason, 'malicious_host');
    assert.equal(malicious.contactName, '封鎖·惡意域名');
    assert.equal(contactNameForBlock({ blockReason: 'malicious_host' }), '封鎖·惡意域名');
  });

  it('archives an LLM decision without a malicious-host hit and does not block', () => {
    const decision = applyBlockPolicy(
      { action: 'archive', archiveReason: 'llm_review_scam' },
      {
        savedContact: false,
        heuristic: { hit: false },
      },
    );
    assert.equal(decision.action, 'archive');
    assert.equal(decision.blockReason, undefined);
  });

  it('never blocks saved contacts even with heuristic hits', () => {
    const saved = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: true,
        heuristic: { hit: true, id: 'lookalike_domain' },
      },
    );
    assert.equal(saved.action, 'archive');
    assert.equal(saved.contactName, undefined);
  });

  it('does not block when the decision stays ignore or was released', () => {
    const ignored = applyBlockPolicy(
      { action: 'ignore', archiveReason: null },
      {
        savedContact: false,
        heuristic: { hit: false },
      },
    );
    assert.equal(ignored.action, 'ignore');

    const released = applyBlockPolicy(
      { action: 'ignore', archiveReason: null, released: true },
      {
        savedContact: false,
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
        heuristic: { hit: true, id: 'malicious_host' },
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
      contactName: '封鎖·假域名',
    });
    assert.deepEqual(calls, [
      ['block'],
      ['rename', '85261234567', '封鎖·假域名', ''],
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

  it('archives an unsaved LLM scam judgment without blocking', async () => {
    const { primaryPathDeps, scamLlmFetch } = require('./test-llm');
    const actions = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請睇下這個轉帳連結',
        chatId: '85269990000@c.us',
        savedContact: false,
        pushName: '陌生',
        messageId: 'block-llm',
      },
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
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
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(actions, [['archive', 'llm_review_scam']]);
    assert.equal(records.length, 0);
  });

  it('archives an unsaved obvious scam without blocking while the setup choice is unanswered', async () => {
    const { primaryPathDeps } = require('./test-llm');
    let blocked = false;
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: 'hold-block@c.us',
        savedContact: false,
        messageId: 'hold-block',
      },
      primaryPathDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient('benign'),
        holdBlock: true,
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
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.heldBlock, undefined);
    assert.equal(blocked, false);
    assert.deepEqual(reasons, ['llm_review_scam']);
  });

  it('holds auto-block while the setup choice is unanswered (malicious host only)', async () => {
    const { llmChatResponse } = require('./test-llm');
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/login',
        chatId: 'hold-mal@c.us',
        savedContact: false,
        messageId: 'hold-mal',
      },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
        },
        holdBlock: true,
        resolveNumber: async () => ({
          digits: '85260001234',
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
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.heldBlock, true);
    assert.equal(blocked, false);
  });

  it('blocks a malicious host after masked LLM confirmation', async () => {
    const { llmChatResponse } = require('./test-llm');
    const stub = createStubJevlikeClient();
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/login',
        chatId: 'fast-heur@c.us',
        savedContact: false,
        messageId: 'fast-heur',
      },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: {
          async maskMessages(messages) {
            return stub.maskMessages(messages);
          },
        },
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
        },
        resolveNumber: async () => ({
          digits: '85260004321',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async (info) => {
          blocked = info.contactName;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'block');
    assert.equal(blocked, '封鎖·惡意域名');
  });

  it('archives a lookalike without blocking below the score threshold', async () => {
    const { primaryPathDeps } = require('./test-llm');
    const names = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: '14155550123@c.us',
        savedContact: false,
        messageId: 'block-heuristic',
      },
      primaryPathDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient('benign'),
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
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(names, []);
  });

  it('archives when the LLM flags an ambiguous unsaved DM', async () => {
    const { primaryPathDeps, scamLlmFetch } = require('./test-llm');
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
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
        resolveNumber: async () => ({
          digits: '85260000001',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
        blockContact: async () => {
          blocked = true;
        },
        recordBlock: async () => {},
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blocked, false);
    assert.deepEqual(reasons, ['llm_review_scam']);
  });

  it('does not block a saved contact on LLM archive', async () => {
    const { primaryPathDeps, scamLlmFetch } = require('./test-llm');
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請睇下',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'saved-high',
      },
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blocked, false);
  });

  it('does not block when the LLM says not_scam', async () => {
    const { primaryPathDeps, notScamLlmFetch } = require('./test-llm');
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚食飯我之後PayMe返你，唔使急',
        chatId: '85261234567@c.us',
        savedContact: false,
        messageId: 'llm-release-unsaved',
      },
      primaryPathDeps({
        fetchImpl: notScamLlmFetch({ reason: 'friend' }),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
        },
        recordBlock: async () => {},
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(blocked, false);
  });

  it('still archives when block throws, and records the failure', async () => {
    const { llmChatResponse } = require('./test-llm');
    const logged = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/verify',
        chatId: '85260000002@c.us',
        savedContact: false,
        messageId: 'block-throws',
      },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
        },
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
    assert.equal(out.decision.contactName, '封鎖·惡意域名');
    assert.equal(logged[0].blocked, false);
    assert.equal(logged[0].archived, true);
    assert.match(logged[0].errors[0], /block rejected/);
  });

  it('still returns when archive throws, and records the error after a block', async () => {
    const { llmChatResponse } = require('./test-llm');
    const logged = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/verify',
        chatId: '85260000003@c.us',
        savedContact: false,
        messageId: 'archive-throws',
      },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
        },
        resolveNumber: async () => ({
          digits: '85260000003',
          unresolvedLid: false,
        }),
        archiveChat: async () => {
          throw new Error('archive down');
        },
        blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
        recordBlock: async (record) => logged.push(record),
      },
    );
    assert.equal(out.decision.action, 'block');
    assert.equal(out.blocked, true);
    assert.equal(out.archived, false);
    assert.equal(logged[0].archived, false);
    assert.match(logged[0].errors.join('\n'), /archive:archive down/);
  });

  it('still returns the block when the block log throws', async () => {
    const { llmChatResponse } = require('./test-llm');
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/verify',
        chatId: '85260000004@c.us',
        savedContact: false,
        messageId: 'log-throws',
      },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
        },
        resolveNumber: async () => ({
          digits: '85260000004',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
        blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
        recordBlock: async () => {
          throw new Error('disk full');
        },
      },
    );
    assert.equal(out.blocked, true);
    assert.equal(out.archived, true);
    assert.equal(out.decision.action, 'block');
  });
});

describe('bot-written contact names', () => {
  const contact = (name, number = '85261234567') => ({
    isMyContact: true, name, number, id: { _serialized: `${number}@c.us`, user: number },
  });

  it('do not make a sender a saved contact while the name is still the one the bot wrote', () => {
    const names = createBotContactNames();
    names.record(null, '+852 6123 4567', SUSPICIOUS_PITCH_CONTACT_NAME);
    for (const live of [contact(SUSPICIOUS_PITCH_CONTACT_NAME), contact(` ${SUSPICIOUS_PITCH_CONTACT_NAME} `)]) {
      assert.equal(isOperatorSavedContact(live, names), false);
      assert.equal(isUnsavedContact(live, names), true);
    }
  });

  it('keep the saved-contact protection when the user chose the same text', () => {
    const names = createBotContactNames();
    names.record(null, '85261234567', SUSPICIOUS_PITCH_CONTACT_NAME);
    for (const live of [
      contact(SUSPICIOUS_PITCH_CONTACT_NAME, '85269999999'),
      contact(contactNameForBlock()),
      contact('Ada'),
    ]) {
      assert.equal(isOperatorSavedContact(live, names), true, `${live.number} ${live.name}`);
      assert.equal(isUnsavedContact(live, names), false, `${live.number} ${live.name}`);
    }
    assert.equal(isOperatorSavedContact(contact(SUSPICIOUS_PITCH_CONTACT_NAME)), true);
    assert.equal(isUnsavedContact({ isMyContact: false }), true);
    assert.equal(isUnsavedContact({}), false);
    assert.equal(isUnsavedContact(null), false);
  });
});
