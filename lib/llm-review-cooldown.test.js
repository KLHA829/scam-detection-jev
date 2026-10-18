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
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();
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
    rubric,
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
});

describe('processIncomingMessage llm cooldown', () => {
  it('skips LLM and mask for a second message in the same chat within the window', async () => {
    const store = createLlmReviewCooldownStore();
    let llmCalls = 0;
    const fetchImpl = async () => {
      llmCalls += 1;
      return llmJsonResponse({
        label: 'not_scam',
        confidence: 0.2,
        signals: [],
        should_archive: false,
        reason: 'ok',
      })();
    };
    const deps = baseDeps({ fetchImpl, store });
    const body = '今晚方便傾兩句嗎？我電話 +852 6123 4567';

    const first = await processIncomingMessage(
      { type: 'chat', body, chatId: CHAT_A, savedContact: true, messageId: 'cd-1' },
      deps,
    );
    assert.equal(first.llmTrigger.trigger, true);
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

  it('calls LLM again after the cooldown window expires', async () => {
    const store = createLlmReviewCooldownStore();
    let llmCalls = 0;
    const fetchImpl = async () => {
      llmCalls += 1;
      return llmJsonResponse({
        label: 'not_scam',
        confidence: 0.2,
        signals: [],
        should_archive: false,
        reason: 'ok',
      })();
    };
    const deps = baseDeps({ fetchImpl, store });
    const body = '今晚方便傾兩句嗎？';

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
        label: 'not_scam',
        confidence: 0.1,
        signals: [],
        should_archive: false,
        reason: 'ok',
      })();
    };
    const depsA = baseDeps({ fetchImpl, store, chatId: CHAT_A });
    await processIncomingMessage(
      {
        type: 'chat',
        body: 'chat A',
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
        body: 'chat B',
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
        label: 'not_scam',
        confidence: 0.1,
        signals: [],
        should_archive: false,
        reason: 'ok',
      })();
    };
    const deps = baseDeps({ fetchImpl, store });
    const reasons = [];
    await processIncomingMessage(
      {
        type: 'chat',
        body: '普通訊息',
        chatId: CHAT_A,
        savedContact: true,
        messageId: 'cd-heur-1',
      },
      deps,
    );
    assert.equal(llmCalls, 1);

    const heuristicOut = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: CHAT_A,
        savedContact: true,
        messageId: 'cd-heur-2',
      },
      {
        ...deps,
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(heuristicOut.decision.action, 'archive');
    assert.equal(heuristicOut.decision.archiveReason, 'obvious_scam');
    assert.equal(llmCalls, 1);
    assert.deepEqual(reasons, ['obvious_scam']);
  });
});
