'use strict';

/**
 * Offline locks for AGENTS.md decision invariants (block vs archive, fail-closed mask/LLM).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/block-log-test-setup');

const {
  applyBlockPolicy,
  blockEligibility,
} = require('./block-policy');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');

function llmJson(action, confidence = 0.9) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ action, strong: true, confidence, reason: 'invariant' }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('AGENTS.md invariants — block eligibility', () => {
  it('invariant: saved contacts are never auto-blocked (blockEligibility stays null)', () => {
    assert.equal(
      blockEligibility({
        savedContact: true,
        heuristic: { hit: true, id: 'lookalike_domain' },
      }),
      null,
    );
  });

  it('invariant: blockEligibility stays null without a malicious_host match', () => {
    assert.equal(
      blockEligibility({
        savedContact: false,
        heuristic: { hit: false },
      }),
      null,
    );
  });

  it('invariant: unsaved lookalike link rule does not auto-block (archive only)', () => {
    assert.equal(
      blockEligibility({
        savedContact: false,
        heuristic: { hit: true, id: 'lookalike_domain', archiveReason: 'obvious_scam' },
      }),
      null,
    );
  });

  it('invariant: unsaved malicious_host on the current message may block', () => {
    const eligibility = blockEligibility({
      savedContact: false,
      heuristic: { hit: true, id: 'malicious_host', archiveReason: 'obvious_scam' },
    });
    assert.equal(eligibility.blockReason, 'malicious_host');
    assert.equal(eligibility.contactName, '封鎖·惡意域名');
  });

  it('invariant: applyBlockPolicy never upgrades a saved contact recommendation to block', () => {
    const primary = { action: 'archive', archiveReason: 'obvious_scam' };
    const after = applyBlockPolicy(primary, {
      savedContact: true,
      heuristic: { hit: true, id: 'lookalike_domain' },
    });
    assert.equal(after.action, 'archive');
    assert.equal(after.contactName, undefined);
  });

  it('invariant: applyBlockPolicy keeps archive without a malicious_host match', () => {
    const primary = { action: 'archive', archiveReason: 'llm_review_scam' };
    const after = applyBlockPolicy(primary, {
      savedContact: false,
      heuristic: { hit: false },
    });
    assert.equal(after.action, 'archive');
    assert.equal(after.blockReason, undefined);
  });

  it('invariant: ignore decision never promotes to block via applyBlockPolicy', () => {
    const after = applyBlockPolicy(
      { action: 'ignore', archiveReason: null },
      {
        savedContact: false,
        heuristic: { hit: false },
      },
    );
    assert.equal(after.action, 'ignore');
  });
});

describe('AGENTS.md invariants — processIncomingMessage integration', () => {
  for (const contextOn of [true, false]) {
    const path = contextOn ? 'default context' : 'single-message';
    for (const [verdict, reply] of [
      ['benign', contextOn ? { action: 'no_action' } : { label: 'not_scam' }],
      ['scam', contextOn ? { action: 'archive', strong: true } : { label: 'scam' }],
      ['invalid', {}],
      ['unavailable', null],
    ]) {
      it(`invariant: keyword rules require AI confirmation (${path}, ${verdict})`, async () => {
        for (const [id, body] of [
          ['lookalike_domain', '登入 https://hsbc.evil.com/login'],
          [null, '請提供驗證碼 https://bit.ly/fee'],
        ]) {
          const archives = [];
          let reviews = 0;
          const env = {
            BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
            LLM_REVIEW_MIN_CONFIDENCE: '0.7',
            LLM_REVIEW_COOLDOWN_MS: '0',
            ...(contextOn ? {} : { CONTEXT_LLM_ENABLED: 'false' }),
          };
          const out = await processIncomingMessage(
            { chatId: 'rule-review@c.us', type: 'chat', body, savedContact: false },
            {
              env,
              maskClient: createStubJevlikeClient(),
              llmReview: {
                apiKey: reply ? 'test' : undefined,
                apiUrl: reply ? 'https://llm.invalid/v1' : '',
                fetchImpl: async () => {
                  reviews += 1;
                  return new Response(JSON.stringify({
                    choices: [{ message: { content: JSON.stringify({ ...reply, strong: true, confidence: 0.9 }) } }],
                  }));
                },
              },
              archiveChat: async (reason) => archives.push(reason),
              blockContact: async () => assert.fail('keyword rules must not block'),
            },
          );
          assert.equal(out.heuristic.id, id);
          assert.deepEqual(archives, verdict === 'scam'
            ? [contextOn ? 'context_llm' : 'llm_review_scam']
            : []);
          assert.equal(reviews, reply ? 1 : 0);
          assert.equal(out.blocked, false);
        }
      });
    }
  }

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

  it('invariant: saved contact LLM scam is deferred without archiving or blocking', async () => {
    let blockCalls = 0;
    let archiveCalls = 0;
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
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
        resolveNumber: async () => ({ digits: '85261230000', unresolvedLid: false }),
        archiveChat: async () => { archiveCalls += 1; },
        blockContact: async () => {
          blockCalls += 1;
        },
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.deferred, true);
    assert.equal(archiveCalls, 0);
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

  it('invariant: unsaved lookalike does not archive or block when AI is disabled', async () => {
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
          async maskMessages(messages) {
            return createStubJevlikeClient().maskMessages(messages);
          },
        },
        llmReview: { enabled: false },
        resolveNumber: async () => ({ digits: '85269995555', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.archiveReason, null);
    assert.equal(blocked, false);
    assert.deepEqual(archives, []);
  });
});

describe('AGENTS.md invariants — defensive gauntlet', () => {
  const FIXTURE_PHONE = '90001122';
  const FIXTURE_BODY = `FIXTURE_CONTACT_LABEL 電話${FIXTURE_PHONE}`;

  const linkHardArchiveCases = [
    {
      id: 'malicious_host',
      body: '按此 https://malicious-block-test.invalid/login',
      action: 'block',
    },
    {
      id: 'malicious_email_host',
      body: '電郵 help@hutong.biz',
      action: 'archive',
    },
  ];

  it('invariant: saved contact on malicious_host is deferred without archiving or blocking', async () => {
    assert.equal(
      blockEligibility({
        savedContact: true,
        heuristic: { hit: true, id: 'malicious_host', archiveReason: null },
      }),
      null,
    );

    let blockCalls = 0;
    let archiveCalls = 0;
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
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient('benign'),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmJson('block'),
        },
        resolveNumber: async () => ({ digits: '85261239999', unresolvedLid: false }),
        archiveChat: async () => { archiveCalls += 1; },
        blockContact: async () => {
          blockCalls += 1;
        },
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.deferred, true);
    assert.equal(out.decision.blockReason, undefined);
    assert.equal(archiveCalls, 0);
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
    assert.match(out.redacted, /<PHONE_1>/);
    assert.equal(out.decision.action, 'ignore');
  });

  for (const { id, body, action } of linkHardArchiveCases) {
    it(`invariant: ${id} routes through mask -> LLM (no raw host leak) and fails closed on benign/mask-fail`, async () => {
      const { scamLlmFetch, notScamLlmFetch } = require('./test-llm');
      let primaryLlm = 0;
      let contextLlm = 0;
      let maskCalls = 0;
      let primarySys = '';
      let contextSys = '';
      const client = createStubJevlikeClient('benign');
      const origMask = client.maskMessages.bind(client);
      client.maskMessages = async (...args) => {
        maskCalls += 1;
        return origMask(...args);
      };
      const baseDeps = {
        maskClient: client,
        resolveNumber: async () => ({ digits: '85260000000', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
        recordBlock: async () => {},
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
          env: {
            CONTEXT_LLM_ENABLED: 'false',
            LLM_REVIEW_ENABLED: 'true',
            LLM_REVIEW_COOLDOWN_MS: '0',
            BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
          },
          llmReview: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            fetchImpl: async (_url, opts) => {
              primaryLlm += 1;
              primarySys = JSON.parse(opts.body).messages.find((m) => m.role === 'system').content;
              return scamLlmFetch()();
            },
          },
        },
      );
      assert.equal(primaryOut.llmTrigger.trigger, true);
      assert.equal(primaryOut.decision.action, action);
      assert.equal(primaryLlm, 1);
      assert.equal(maskCalls, 1);
      assert.match(primarySys, /confirmed malicious-host list/i);
      assert.equal(primarySys.includes(primaryOut.heuristic.matchedHost), false);

      // Benign LLM verdict (e.g. anti-scam warning) does not archive or block.
      const benignOut = await processIncomingMessage(
        {
          type: 'chat',
          body,
          chatId: `gauntlet-benign-${id}@c.us`,
          savedContact: false,
          messageId: `gauntlet-b-${id}`,
        },
        {
          ...baseDeps,
          env: {
            CONTEXT_LLM_ENABLED: 'false',
            LLM_REVIEW_ENABLED: 'true',
            LLM_REVIEW_COOLDOWN_MS: '0',
          },
          llmReview: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            fetchImpl: notScamLlmFetch(),
          },
        },
      );
      assert.equal(benignOut.decision.action, 'ignore');

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
          env: {
            LLM_REVIEW_COOLDOWN_MS: '0',
            BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
          },
          contextLlm: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            fetchImpl: async (_url, opts) => {
              contextLlm += 1;
              contextSys = JSON.parse(opts.body).messages.find((m) => m.role === 'system').content;
              return llmJson('archive')();
            },
          },
        },
      );
      assert.equal(contextOut.llmTrigger.trigger, true);
      assert.equal(contextOut.decision.action, action);
      assert.equal(contextLlm, 1);
      assert.equal(maskCalls, 1);
      assert.match(contextSys, /confirmed malicious-host list/i);
      assert.equal(contextSys.includes(contextOut.heuristic.matchedHost), false);
    });
  }

  it('ignores @newsletter channels and captionless empty-body DMs in context mode before mask/LLM', async () => {
    const { primaryPathDeps } = require('./test-llm');
    let maskCalls = 0;
    const base = primaryPathDeps({
      env: { CONTEXT_LLM_ENABLED: 'true', LLM_REVIEW_ENABLED: 'true', LLM_REVIEW_COOLDOWN_MS: '0' },
      maskClient: {
        async maskMessages() {
          maskCalls += 1;
          return [];
        },
      },
      fetchImpl: async () => {
        throw new Error('llm must not run');
      },
    });

    const channelOut = await processIncomingMessage(
      { type: 'chat', body: '登入 https://malicious-block-test.invalid', chatId: '12345@newsletter', savedContact: false },
      base,
    );
    assert.deepEqual(channelOut, { ignored: true, reason: 'channel' });

    const captionlessOut = await processIncomingMessage(
      { type: 'image', body: '', chatId: '85291234567@c.us', savedContact: false, messageId: 'img-1' },
      base,
    );
    assert.equal(captionlessOut.decision.action, 'ignore');
    assert.equal(captionlessOut.llmTrigger.skipped, 'empty_body');
    assert.equal(maskCalls, 0);
  });

  it('backs up corrupt operator-mode JSON and refuses to clobber on transient read errors', (t) => {
    const nodeFs = require('node:fs');
    const nodeOs = require('node:os');
    const nodePath = require('node:path');
    const { createOperatorState } = require('./operator-mode');
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'op-mode-'));
    t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));

    const corruptPath = nodePath.join(dir, 'operator-mode.json');
    nodeFs.writeFileSync(corruptPath, '{corrupt');
    const recovered = createOperatorState({ env: {}, filePath: corruptPath });
    assert.equal(recovered.mode(), 'auto');
    assert.equal(recovered.snapshot().needsSetup, true);
    assert.ok(nodeFs.readdirSync(dir).some((f) => f.startsWith('operator-mode.json.corrupt.')));
    recovered.choose('guided');
    assert.equal(createOperatorState({ env: {}, filePath: corruptPath }).mode(), 'guided');

    const eisdirPath = nodePath.join(dir, 'as-dir');
    nodeFs.mkdirSync(eisdirPath);
    const transient = createOperatorState({ env: {}, filePath: eisdirPath });
    assert.throws(() => transient.choose('auto'));
    assert.equal(nodeFs.statSync(eisdirPath).isDirectory(), true);
  });
});
