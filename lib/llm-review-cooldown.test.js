'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  llmReviewCooldownMs,
  createLlmReviewCooldownStore,
  isChatLlmCooldownActive,
  recordChatLlmReviewSuccess,
  DEFAULT_COOLDOWN_MS,
} = require('./llm-review-cooldown');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');

const GREY_PROB = 0.41;
const CHAT_A = '85261234567@c.us';
const CHAT_B = '85269998888@c.us';

function llmJsonResponse(obj) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(obj) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function baseDeps({ fetchImpl, store, chatId = CHAT_A }) {
  let maskCalls = 0;
  const client = createStubJevlikeClient(GREY_PROB);
  const origMask = client.maskMessages.bind(client);
  client.maskMessages = async (...args) => {
    maskCalls += 1;
    return origMask(...args);
  };
  return {
    env: {
      LLM_REVIEW_ENABLED: 'true',
      CONTEXT_LLM_ENABLED: 'false',
      LLM_REVIEW_COOLDOWN_MS: String(DEFAULT_COOLDOWN_MS),
    },
    maskClient: client,
    llmCooldownStore: store,
    llmReview: {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      fetchImpl,
    },
    resolveNumber: async () => ({
      digits: chatId.replace('@c.us', ''),
      unresolvedLid: false,
    }),
    archiveChat: async () => {},
    get maskCalls() {
      return maskCalls;
    },
  };
}

function archiveReviewDeps(contextOn, store) {
  const fetchImpl = llmJsonResponse(
    contextOn
      ? { action: 'archive', confidence: 0.9, reason: 'investment' }
      : { label: 'scam', confidence: 0.9, should_archive: true, reason: 'investment' },
  );
  const deps = baseDeps({ fetchImpl, store });
  deps.env.CONTEXT_LLM_ENABLED = contextOn ? '1' : '0';
  return deps;
}

describe('llm-review-cooldown helpers', () => {
  it('reads LLM_REVIEW_COOLDOWN_MS with production default when unset', () => {
    assert.equal(
      llmReviewCooldownMs({ LLM_REVIEW_COOLDOWN_MS: '120000' }),
      120_000,
    );
    const saved = process.env.LLM_REVIEW_COOLDOWN_MS;
    delete process.env.LLM_REVIEW_COOLDOWN_MS;
    try {
      assert.equal(llmReviewCooldownMs({}), DEFAULT_COOLDOWN_MS);
    } finally {
      if (saved === undefined) delete process.env.LLM_REVIEW_COOLDOWN_MS;
      else process.env.LLM_REVIEW_COOLDOWN_MS = saved;
    }
  });

  it('tracks per-chat windows', () => {
    const store = createLlmReviewCooldownStore();
    const env = { LLM_REVIEW_COOLDOWN_MS: '600000' };
    const now = 1_000_000;
    assert.equal(isChatLlmCooldownActive('x', env, { store, now }), false);
    recordChatLlmReviewSuccess('x', { store, now });
    assert.equal(isChatLlmCooldownActive('x', env, { store, now: now + 1 }), true);
    assert.equal(isChatLlmCooldownActive('x', env, { store, now: now + 600_000 }), false);
    assert.equal(isChatLlmCooldownActive('y', env, { store, now: now + 1 }), false);
  });

  it('persists across store reload (process restart) until expiry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cd-'));
    const filePath = path.join(dir, 'cooldown.json');
    const env = { LLM_REVIEW_COOLDOWN_MS: '600000' };
    const now = Date.now() - 30_000;
    const storeA = createLlmReviewCooldownStore({ filePath, env });
    recordChatLlmReviewSuccess('85261234567@c.us', { store: storeA, now });
    assert.ok(fs.existsSync(filePath));

    const storeB = createLlmReviewCooldownStore({ filePath, env });
    assert.equal(
      isChatLlmCooldownActive('85261234567@c.us', env, { store: storeB, now: now + 60_000 }),
      true,
    );

    storeB.set('85261234567@c.us', now - 600_001);
    const storeC = createLlmReviewCooldownStore({ filePath, env });
    assert.equal(
      isChatLlmCooldownActive('85261234567@c.us', env, { store: storeC, now: Date.now() }),
      false,
    );
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(onDisk.lastReviewByChat, {});
  });

  it('prunes expired chat entries on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cd-prune-'));
    const filePath = path.join(dir, 'cooldown.json');
    const env = { LLM_REVIEW_COOLDOWN_MS: '1000' };
    const stale = Date.now() - 5000;
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        lastReviewByChat: {
          fresh: Date.now() - 100,
          stale,
        },
      })}\n`,
    );
    const store = createLlmReviewCooldownStore({ filePath, env });
    assert.ok(store.get('fresh') != null);
    assert.equal(store.get('stale'), undefined);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.lastReviewByChat.stale, undefined);
    assert.ok(onDisk.lastReviewByChat.fresh != null);
  });

  it('loads active cooldowns even when pruning the cooldown file cannot be saved', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cd-prune-fail-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'cooldown.json');
    const env = { LLM_REVIEW_COOLDOWN_MS: String(DEFAULT_COOLDOWN_MS) };
    const fresh = Date.now();
    const entries = { lastReviewByChat: { fresh, stale: fresh - DEFAULT_COOLDOWN_MS } };
    fs.writeFileSync(filePath, JSON.stringify(entries));
    // Block the atomic write on any platform without relying on chmod permissions.
    fs.mkdirSync(`${filePath}.${process.pid}.tmp`);

    const store = createLlmReviewCooldownStore({ filePath, env });

    assert.equal(store.get('fresh'), fresh);
    assert.equal(store.get('stale'), undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), entries);
  });
});

describe('processIncomingMessage llm cooldown', () => {
  it('skips LLM and mask for a second message in the same chat within the window', async () => {
    const store = createLlmReviewCooldownStore();
    let llmCalls = 0;
    const fetchImpl = async () => {
      llmCalls += 1;
      return llmJsonResponse({
        label: 'scam',
        confidence: 0.9,
        signals: ['investment'],
        should_archive: true,
        reason: 'investment',
      })();
    };
    const deps = baseDeps({ fetchImpl, store });
    const body = '高回報投資，加我 WhatsApp 了解';

    const first = await processIncomingMessage(
      { type: 'chat', body, chatId: CHAT_A, savedContact: true, messageId: 'cd-1' },
      deps,
    );
    assert.equal(first.llmTrigger.trigger, true);
    assert.equal(first.decision.action, 'archive');
    assert.equal(llmCalls, 1);
    assert.ok(deps.maskCalls >= 1);

    const maskBefore = deps.maskCalls;
    const second = await processIncomingMessage(
      { type: 'chat', body: '第二句', chatId: CHAT_A, savedContact: true, messageId: 'cd-2' },
      deps,
    );
    assert.equal(second.llmTrigger.skipped, 'cooldown');
    assert.equal(second.decision.action, 'ignore');
    assert.equal(llmCalls, 1);
    assert.equal(deps.maskCalls, maskBefore);
  });

  it('does not cooldown-block after a benign review in primary or context mode', async () => {
    for (const contextOn of [false, true]) {
      const store = createLlmReviewCooldownStore();
      let llmCalls = 0;
      const fetchImpl = async (_url, options) => {
        llmCalls += 1;
        const userMessage = JSON.parse(options.body).messages.find(
          (message) => message.role === 'user',
        ).content;
        const scam = /高回報投資/.test(userMessage);
        return llmJsonResponse(
          contextOn
            ? {
                action: scam ? 'archive' : 'no_action',
                confidence: scam ? 0.9 : 0.2,
                reason: scam ? 'investment' : 'benign',
              }
            : {
                label: scam ? 'scam' : 'not_scam',
                confidence: scam ? 0.9 : 0.2,
                signals: scam ? ['investment'] : [],
                should_archive: scam,
                reason: scam ? 'investment' : 'benign',
              },
        )();
      };
      const deps = baseDeps({ fetchImpl, store });
      deps.env.CONTEXT_LLM_ENABLED = contextOn ? '1' : '0';

      const first = await processIncomingMessage(
        {
          type: 'chat',
          body: '你好，請問係陳生嗎？',
          chatId: CHAT_A,
          savedContact: false,
          messageId: `cd-benign-${contextOn}-1`,
        },
        deps,
      );
      assert.equal(first.decision.action, 'ignore');
      assert.equal(first.llmReview.ok, true);

      const second = await processIncomingMessage(
        {
          type: 'chat',
          body: '高回報投資，加我 WhatsApp 了解',
          chatId: CHAT_A,
          savedContact: false,
          messageId: `cd-benign-${contextOn}-2`,
        },
        deps,
      );
      assert.equal(second.llmTrigger.trigger, true);
      assert.equal(second.decision.action, 'archive');
      assert.equal(llmCalls, 2);
    }
  });

  it('starts cooldown after an archive in primary or context mode', async () => {
    for (const contextOn of [false, true]) {
      const store = createLlmReviewCooldownStore();
      let llmCalls = 0;
      const fetchImpl = async (_url, options) => {
        llmCalls += 1;
        const userMessage = JSON.parse(options.body).messages.find(
          (message) => message.role === 'user',
        ).content;
        const scam = /高回報投資/.test(userMessage);
        return llmJsonResponse(
          contextOn
            ? {
                action: scam ? 'archive' : 'no_action',
                confidence: 0.9,
                reason: scam ? 'investment' : 'benign',
              }
            : {
                label: scam ? 'scam' : 'not_scam',
                confidence: 0.9,
                signals: scam ? ['investment'] : [],
                should_archive: scam,
                reason: scam ? 'investment' : 'benign',
              },
        )();
      };
      const deps = baseDeps({ fetchImpl, store });
      deps.env.CONTEXT_LLM_ENABLED = contextOn ? '1' : '0';

      const first = await processIncomingMessage(
        {
          type: 'chat',
          body: '高回報投資，加我 WhatsApp 了解',
          chatId: CHAT_A,
          savedContact: false,
          messageId: `cd-archive-${contextOn}-1`,
        },
        deps,
      );
      assert.equal(first.decision.action, 'archive');

      const second = await processIncomingMessage(
        {
          type: 'chat',
          body: '第二句',
          chatId: CHAT_A,
          savedContact: false,
          messageId: `cd-archive-${contextOn}-2`,
        },
        deps,
      );
      assert.equal(second.llmTrigger.skipped, 'cooldown');
      assert.equal(llmCalls, 1);
    }
  });

  const scamMessage = {
    type: 'chat', body: '高回報投資，加我 WhatsApp 了解', chatId: CHAT_A, savedContact: false,
  };

  it('retries review after an automatic archive fails', async (t) => {
    for (const contextOn of [false, true]) {
      await t.test(contextOn ? 'context' : 'primary', async () => {
        const store = createLlmReviewCooldownStore();
        const deps = archiveReviewDeps(contextOn, store);
        let archiveCalls = 0;
        deps.archiveChat = async () => {
          if (++archiveCalls === 1) throw new Error('archive unavailable');
        };

        const first = await processIncomingMessage({ ...scamMessage, messageId: 'cd-fail' }, deps);
        const afterFailure = store.get(CHAT_A);
        const retry = await processIncomingMessage({ ...scamMessage, messageId: 'cd-retry' }, deps);

        assert.equal(first.decision.action, 'archive');
        assert.equal(first.archived, false);
        assert.equal(retry.llmTrigger.trigger, true, `follow-up skipped: ${retry.llmTrigger.skipped}`);
        assert.equal(retry.archived, true);
        assert.equal(archiveCalls, 2);
        assert.equal(afterFailure, undefined);
        assert.equal(isChatLlmCooldownActive(CHAT_A, deps.env, { store }), true);
      });
    }
  });

  it('preserves an automatic archive when the cooldown file cannot be written', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cd-write-fail-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parent = path.join(dir, 'not-a-directory');
    fs.writeFileSync(parent, '');

    for (const contextOn of [false, true]) {
      await t.test(contextOn ? 'context' : 'primary', async () => {
        const store = createLlmReviewCooldownStore({ filePath: path.join(parent, 'cooldown.json') });
        const deps = archiveReviewDeps(contextOn, store);
        let cooldownAtArchive;
        deps.archiveChat = async () => { cooldownAtArchive = store.get(CHAT_A); };

        const out = await processIncomingMessage(scamMessage, deps);
        assert.equal(out.archived, true);
        assert.equal(cooldownAtArchive, undefined);
        assert.equal(isChatLlmCooldownActive(CHAT_A, deps.env, { store }), true);
      });
    }
  });

  it('keeps the guided cooldown while archive is deferred', async (t) => {
    for (const contextOn of [false, true]) {
      await t.test(contextOn ? 'context' : 'primary', async () => {
        const store = createLlmReviewCooldownStore();
        const deps = archiveReviewDeps(contextOn, store);
        deps.operatorMode = 'guided';

        const out = await processIncomingMessage(scamMessage, deps);
        assert.equal(out.deferred, true);
        assert.equal(out.archived, false);
        assert.equal(isChatLlmCooldownActive(CHAT_A, deps.env, { store }), true);
      });
    }
  });

  it('calls LLM again after the cooldown window expires', async () => {
    const store = createLlmReviewCooldownStore();
    let llmCalls = 0;
    const fetchImpl = async () => {
      llmCalls += 1;
      return llmJsonResponse({
        label: 'scam',
        confidence: 0.9,
        signals: ['investment'],
        should_archive: true,
        reason: 'investment',
      })();
    };
    const deps = baseDeps({ fetchImpl, store });
    const body = '高回報投資';

    await processIncomingMessage(
      { type: 'chat', body, chatId: CHAT_A, savedContact: true, messageId: 'cd-exp-1' },
      deps,
    );
    assert.equal(llmCalls, 1);
    const last = store.get(CHAT_A);
    assert.ok(last != null);
    store.set(CHAT_A, last - DEFAULT_COOLDOWN_MS - 1);

    await processIncomingMessage(
      { type: 'chat', body: '過咗窗口', chatId: CHAT_A, savedContact: true, messageId: 'cd-exp-2' },
      deps,
    );
    assert.equal(llmCalls, 2);
  });

  it('does not cooldown-block a different chat', async () => {
    const store = createLlmReviewCooldownStore();
    let llmCalls = 0;
    const fetchImpl = async () => {
      llmCalls += 1;
      return llmJsonResponse({
        label: 'scam',
        confidence: 0.9,
        signals: ['investment'],
        should_archive: true,
        reason: 'investment',
      })();
    };
    const depsA = baseDeps({ fetchImpl, store, chatId: CHAT_A });
    await processIncomingMessage(
      {
        type: 'chat',
        body: '高回報投資 chat A',
        chatId: CHAT_A,
        savedContact: true,
        messageId: 'cd-other-a',
      },
      depsA,
    );
    const depsB = baseDeps({ fetchImpl, store, chatId: CHAT_B });
    const outB = await processIncomingMessage(
      {
        type: 'chat',
        body: '高回報投資 chat B',
        chatId: CHAT_B,
        savedContact: true,
        messageId: 'cd-other-b',
      },
      depsB,
    );
    assert.equal(llmCalls, 2);
    assert.equal(outB.llmTrigger.trigger, true);
  });

  it('still archives on heuristic hard-hit inside the cooldown window', async () => {
    const store = createLlmReviewCooldownStore();
    let llmCalls = 0;
    const fetchImpl = async () => {
      llmCalls += 1;
      return llmJsonResponse({
        label: 'scam',
        confidence: 0.9,
        signals: ['investment'],
        should_archive: true,
        reason: 'investment',
      })();
    };
    const deps = baseDeps({ fetchImpl, store });
    const reasons = [];
    await processIncomingMessage(
      {
        type: 'chat',
        body: '高回報投資',
        chatId: CHAT_A,
        savedContact: false,
        messageId: 'cd-heur-1',
      },
      deps,
    );
    assert.equal(llmCalls, 1);

    const heuristicOut = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/login',
        chatId: CHAT_A,
        savedContact: false,
        messageId: 'cd-heur-2',
      },
      {
        ...deps,
        env: { ...deps.env, BLOCK_ENABLED: 'false' },
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(heuristicOut.decision.action, 'archive');
    assert.equal(heuristicOut.decision.archiveReason, 'obvious_scam');
    assert.equal(llmCalls, 1);
    assert.deepEqual(reasons, ['obvious_scam']);
  });
});
