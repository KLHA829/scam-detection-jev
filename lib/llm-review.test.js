'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseLlmReview,
  resolveChatCompletionsUrl,
  reviewRedactedMessage,
  shouldTriggerLlmReview,
  mergeLlmDecision,
  createLlmReviewConfig,
  llmReviewAll,
  llmReviewEnabled,
} = require('./llm-review');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric, labelFromScore } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

/** In grey band (0.40–0.85) but below ARCHIVE_THRESHOLD 42. */
const GREY_PROB = 0.41;
/** Above GREY_MAX 0.85 and above archive threshold. */
const HIGH_PROB = 0.92;

const FRIEND_MEAL = '今晚食飯我之後PayMe返你，唔使急';

function llmReviewDeps({ fetchImpl, probScam = HIGH_PROB }) {
  return {
    env: { LLM_REVIEW_ENABLED: 'true', CONTEXT_LLM_ENABLED: '0' },
    maskClient: createStubJevlikeClient(probScam),
    llmReview: {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      fetchImpl,
    },
    resolveNumber: async () => ({
      digits: '85261234567',
      unresolvedLid: false,
    }),
  };
}

function llmJsonResponse(obj, status = 200) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(obj) } }],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
}

describe('llm-review helpers', () => {
  for (const label of ['not_scam', 'unknown', 'invalid', null]) {
    it(`rejects should_archive for non-scam label ${label}`, () => {
      const review = parseLlmReview(JSON.stringify({
        label, confidence: 0.9, should_archive: true,
      }));
      assert.equal(review.should_archive, false);
    });
  }
  it('resolves OpenAI-compatible chat completion URLs', () => {
    assert.equal(
      resolveChatCompletionsUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/chat/completions',
    );
    assert.equal(
      resolveChatCompletionsUrl('http://127.0.0.1:11434'),
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    assert.equal(
      resolveChatCompletionsUrl('http://localhost:8000/v1/chat/completions'),
      'http://localhost:8000/v1/chat/completions',
    );
  });

  it('parses forced JSON and archives only on scam', () => {
    const a = parseLlmReview(
      JSON.stringify({
        label: 'scam',
        confidence: 0.91,
        signals: ['otp'],
        should_archive: false,
        reason: 'otp harvest',
      }),
    );
    assert.equal(a.ok, true);
    assert.equal(a.label, 'scam');
    assert.equal(a.should_archive, true);

    const b = parseLlmReview('```json\n{"label":"unknown","should_archive":true,"confidence":0.2,"signals":[],"reason":"x"}\n```');
    assert.equal(b.ok, true);
    assert.equal(b.should_archive, false);

    const c = parseLlmReview('not json');
    assert.equal(c.ok, false);
    assert.equal(c.label, 'unknown');
    assert.equal(c.should_archive, false);
  });

  it('fail-opens on timeout / HTTP error', async () => {
    const timed = await reviewRedactedMessage('hi', {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      timeoutMs: 20,
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    assert.equal(timed.ok, false);
    assert.equal(timed.label, 'unknown');
    assert.equal(timed.should_archive, false);

    const http = await reviewRedactedMessage('hi', {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    assert.equal(http.ok, false);
    assert.equal(http.should_archive, false);
  });

  it('never sends the PII mapping, only redacted text', async () => {
    const bodies = [];
    await reviewRedactedMessage('請打去 [電話] 同 [電郵]', {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      apiKey: 'sk-test',
      fetchImpl: async (url, opts) => {
        bodies.push({ url, body: JSON.parse(opts.body) });
        return llmJsonResponse({
          label: 'not_scam',
          confidence: 0.1,
          signals: [],
          should_archive: false,
          reason: 'ok',
        })();
      },
    });
    assert.equal(bodies.length, 1);
    const payload = JSON.stringify(bodies[0].body);
    assert.match(payload, /\[電話\]/);
    assert.doesNotMatch(payload, /mapping/);
    assert.doesNotMatch(payload, /91234567/);
    assert.equal(
      bodies[0].body.messages.some((m) => m.role === 'user'),
      true,
    );
  });

  it('sends Bearer only when an API key is set', async () => {
    const headersSeen = [];
    const fetchImpl = async (_url, opts) => {
      headersSeen.push(opts.headers);
      return llmJsonResponse({
        label: 'unknown',
        confidence: 0,
        signals: [],
        should_archive: false,
        reason: 'x',
      })();
    };
    await reviewRedactedMessage('hi', {
      enabled: true,
      apiUrl: 'http://127.0.0.1:8081/v1',
      apiKey: '',
      fetchImpl,
    });
    assert.equal(headersSeen[0].authorization, undefined);

    await reviewRedactedMessage('hi', {
      enabled: true,
      apiUrl: 'http://127.0.0.1:8081/v1',
      apiKey: 'local',
      fetchImpl,
    });
    assert.equal(headersSeen[1].authorization, 'Bearer local');
  });
});

describe('llm triggers', () => {
  for (const label of ['not_scam', 'unknown', 'invalid', null]) {
    it(`merge ignores contradictory non-scam label ${label}`, () => {
      const decision = { action: 'ignore', archiveReason: null };
      assert.deepEqual(mergeLlmDecision(decision, {
        ok: true, label, confidence: 0.9, should_archive: true,
      }), decision);
    });
  }
  it('skips hard archives and disabled review', () => {
    assert.equal(
      shouldTriggerLlmReview({
        decision: { action: 'archive', archiveReason: 'obvious_scam' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        heuristic: { hit: true, archiveReason: 'obvious_scam' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        decision: { action: 'ignore', archiveReason: null },
        enabled: false,
      }).trigger,
      false,
    );
  });

  it('mergeLlmDecision archives on scam, releases score-only archives on not_scam', () => {
    const ignore = { action: 'ignore', archiveReason: null };
    const scoreArchive = { action: 'archive', archiveReason: 'jevlike_score' };
    const jevlikeArchive = { action: 'archive', archiveReason: 'jevlike_score' };
    const heuristicHard = { action: 'archive', archiveReason: 'obvious_scam' };
    assert.deepEqual(mergeLlmDecision(ignore, { ok: false, label: 'unknown' }), ignore);
    assert.deepEqual(
      mergeLlmDecision(ignore, {
        ok: true,
        label: 'scam',
        confidence: 0.85,
        should_archive: true,
      }),
      { action: 'archive', archiveReason: 'llm_review_scam' },
    );
    assert.deepEqual(
      mergeLlmDecision(ignore, {
        ok: true,
        label: 'scam',
        confidence: 0.55,
        should_archive: true,
      }),
      ignore,
    );
    assert.deepEqual(
      mergeLlmDecision(scoreArchive, {
        ok: true,
        label: 'not_scam',
        should_archive: false,
      }),
      {
        action: 'ignore',
        archiveReason: null,
        released: true,
        releaseReason: 'llm_review_not_scam',
      },
    );
    assert.deepEqual(
      mergeLlmDecision(jevlikeArchive, {
        ok: true,
        label: 'not_scam',
        should_archive: false,
      }),
      {
        action: 'ignore',
        archiveReason: null,
        released: true,
        releaseReason: 'llm_review_not_scam',
      },
    );
    assert.deepEqual(
      mergeLlmDecision(
        jevlikeArchive,
        {
          ok: true,
          label: 'not_scam',
          should_archive: false,
        },
        { merge: 'archive_only' },
      ),
      jevlikeArchive,
    );
    assert.deepEqual(
      mergeLlmDecision(scoreArchive, {
        ok: false,
        label: 'unknown',
        should_archive: false,
      }),
      scoreArchive,
    );
    assert.deepEqual(
      mergeLlmDecision(scoreArchive, {
        ok: true,
        label: 'unknown',
        should_archive: false,
      }),
      scoreArchive,
    );
    assert.deepEqual(
      mergeLlmDecision(heuristicHard, {
        ok: true,
        label: 'not_scam',
        should_archive: false,
      }),
      heuristicHard,
    );
  });

  it('createLlmReviewConfig documents defaults, optional key, and OpenAI aliases', () => {
    const cfg = createLlmReviewConfig({
      LLM_REVIEW_ENABLED: 'true',
      LLM_REVIEW_API_URL: 'http://127.0.0.1:8081/v1',
      LLM_REVIEW_API_KEY: 'local',
      LLM_REVIEW_MODEL: 'Ternary-Bonsai-2-27B',
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.minConfidence, 0.7);
    assert.equal(cfg.apiKey, 'local');
    assert.equal(cfg.model, 'Ternary-Bonsai-2-27B');
    assert.equal(
      createLlmReviewConfig({}).reviewAll,
      false,
    );
    assert.equal(
      createLlmReviewConfig({ LLM_REVIEW_ALL: '1' }).reviewAll,
      true,
    );
    assert.equal(
      createLlmReviewConfig({ LLM_REVIEW_ALL: '1' }).enabled,
      true,
    );
    assert.equal(
      createLlmReviewConfig({ LLM_REVIEW_MERGE: 'archive_only' }).merge,
      'archive_only',
    );
    assert.equal(createLlmReviewConfig({}).merge, 'bonsai');
    assert.equal(
      createLlmReviewConfig({
        LLM_REVIEW_API_URL: 'http://127.0.0.1:8081/v1',
      }).apiKey,
      '',
    );
    const viaAlias = createLlmReviewConfig({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-alias',
    });
    assert.equal(viaAlias.apiUrl, 'https://api.openai.com/v1');
    assert.equal(viaAlias.apiKey, 'sk-alias');
  });
});

describe('processIncomingMessage llm second pass', () => {
  for (const label of ['not_scam', 'unknown', 'invalid', null]) {
    it(`does not archive contradictory non-scam reply ${label}`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-nonscam-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      let calls = 0;
      const archives = [];
      const deps = llmReviewDeps({
        fetchImpl: async () => {
          calls += 1;
          return llmJsonResponse({ label, confidence: 0.9, should_archive: true })();
        },
      });
      const out = await processIncomingMessage(
        {
          type: 'chat', body: FRIEND_MEAL, chatId: '85261234567@c.us',
          savedContact: true, messageId: `non-scam-${label}`,
        },
        {
          ...deps,
          env: {
            ...deps.env, LLM_REVIEW_COOLDOWN_MS: '0',
            BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl'),
          },
          archiveChat: async (reason) => archives.push(reason),
        },
      );
      assert.equal(calls, 1);
      assert.equal(out.decision.action, 'ignore');
      assert.deepEqual(archives, []);
    });
  }
  it('archives grey messages when LLM says scam, using redacted text', async () => {
    const greyScore = GREY_PROB * 100;
    assert.ok(greyScore >= 40);
    assert.ok(greyScore < rubric.thresholds.archive);
    assert.equal(labelFromScore(greyScore, rubric.thresholds), 'unknown');

    const seen = [];
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚方便傾兩句嗎？我電話 +852 6123 4567',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'grey-1',
      },
      {
        env: { LLM_REVIEW_ENABLED: 'true', CONTEXT_LLM_ENABLED: '0' },
        maskClient: createStubJevlikeClient(GREY_PROB),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            seen.push(JSON.parse(opts.body));
            return llmJsonResponse({
              label: 'scam',
              confidence: 0.88,
              signals: ['grey'],
              should_archive: true,
              reason: 'uncertain lure',
            })();
          },
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(reasons, ['llm_review_scam']);
    assert.equal(seen.length, 1);
    const user = seen[0].messages.find((m) => m.role === 'user').content;
    assert.match(user, /XXX/);
    assert.doesNotMatch(user, /6123/);
    assert.doesNotMatch(user, /\[電話\]/);
    assert.doesNotMatch(JSON.stringify(seen[0]), /mapping/);
  });

  it('does not call the LLM when the mask head fails', async () => {
    let called = 0;
    const client = createStubJevlikeClient(GREY_PROB);
    client.maskMessages = async () => {
      throw new Error('mask down');
    };
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚方便傾兩句嗎？我電話 +852 6123 4567',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'grey-mask-fail',
      },
      {
        env: { LLM_REVIEW_ENABLED: 'true' },
        maskClient: client,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            called += 1;
            return llmJsonResponse({
              label: 'scam',
              confidence: 0.9,
              signals: [],
              should_archive: true,
              reason: 'should not run',
            })();
          },
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
      },
    );
    assert.equal(called, 0);
    assert.equal(out.llmTrigger.skipped, 'mask_failed');
    assert.equal(out.redacted, null);
    assert.equal(out.decision.action, 'ignore');
  });

  it('does not archive when LLM times out (fail-open)', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚方便傾兩句嗎？',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'grey-timeout',
      },
      {
        env: { CONTEXT_LLM_ENABLED: '0' },
        maskClient: createStubJevlikeClient(GREY_PROB),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          },
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.llmReview.ok, false);
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('skips LLM on heuristic hard archives', async () => {
    let called = 0;
    const heuristicOut = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'hard-heuristic',
      },
      {
        env: { CONTEXT_LLM_ENABLED: '0' },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            called += 1;
            return llmJsonResponse({
              label: 'not_scam',
              should_archive: false,
              confidence: 1,
              signals: [],
              reason: 'should not run',
            })();
          },
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
      },
    );
    assert.equal(heuristicOut.decision.archiveReason, 'obvious_scam');
    assert.equal(heuristicOut.llmTrigger.trigger, false);
    assert.equal(heuristicOut.llmTrigger.skipped, 'hard_archive');
    assert.equal(called, 0);
  });

  it('ignores when LLM says not_scam on the primary path', async () => {
    const reasons = [];
    let called = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'primary-not-scam',
      },
      {
        ...llmReviewDeps({
          fetchImpl: async () => {
            called += 1;
            return llmJsonResponse({
              label: 'not_scam',
              confidence: 0.82,
              signals: ['friend_repay'],
              should_archive: false,
              reason: 'meal repay among friends',
            })();
          },
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(called, 1);
    assert.ok(out.llmTrigger.reasons.includes('primary_review'));
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('keeps a high score archive when LLM says scam', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'high-scam',
      },
      {
        ...llmReviewDeps({
          probScam: HIGH_PROB,
          fetchImpl: async () =>
            llmJsonResponse({
              label: 'scam',
              confidence: 0.9,
              signals: ['money'],
              should_archive: true,
              reason: 'transfer ask',
            })(),
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(reasons, ['llm_review_scam']);
  });

  it('fail-closed: LLM unknown or errors leave ignore (no archive)', async () => {
    const unknownReasons = [];
    const unknownOut = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'primary-unknown',
      },
      {
        ...llmReviewDeps({
          fetchImpl: async () =>
            llmJsonResponse({
              label: 'unknown',
              confidence: 0.1,
              signals: [],
              should_archive: false,
              reason: 'unsure',
            })(),
        }),
        archiveChat: async (reason) => unknownReasons.push(reason),
      },
    );
    assert.equal(unknownOut.decision.action, 'ignore');
    assert.deepEqual(unknownReasons, []);

    const errorReasons = [];
    const errorOut = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'primary-error',
      },
      {
        ...llmReviewDeps({
          fetchImpl: async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          },
        }),
        archiveChat: async (reason) => errorReasons.push(reason),
      },
    );
    assert.equal(errorOut.llmReview.ok, false);
    assert.equal(errorOut.decision.action, 'ignore');
    assert.deepEqual(errorReasons, []);
  });
});

describe('Primary LLM review routing', () => {
  it('LLM_REVIEW_ALL does not override explicitly disabled review', () => {
    const env = { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_ALL: '1' };
    assert.equal(llmReviewEnabled(env), false);
    assert.equal(createLlmReviewConfig(env).enabled, false);
  });

  for (const contextEnabled of [undefined, '0']) {
    it(`LLM_REVIEW_ALL keeps inbound review disabled with context ${contextEnabled ?? 'default'}`, async () => {
      let maskCalls = 0;
      let llmCalls = 0;
      const maskClient = createStubJevlikeClient();
      const maskMessages = maskClient.maskMessages.bind(maskClient);
      maskClient.maskMessages = async (...args) => {
        maskCalls += 1;
        return maskMessages(...args);
      };
      const env = { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_ALL: '1' };
      if (contextEnabled != null) env.CONTEXT_LLM_ENABLED = contextEnabled;
      const out = await processIncomingMessage(
        { type: 'chat', body: '今晚飲茶？', chatId: `disabled-all-${contextEnabled}@c.us`, savedContact: true },
        {
          env,
          maskClient,
          llmReview: {
            apiUrl: 'http://llm.test/v1',
            fetchImpl: async () => {
              llmCalls += 1;
              return llmJsonResponse({ label: 'not_scam', action: 'ignore', confidence: 0.9, should_archive: false })();
            },
          },
        },
      );
      assert.equal(llmCalls, 0);
      assert.equal(maskCalls, 0);
      assert.equal(out.decision.action, 'ignore');
    });
  }

  it('enables primary LLM review by default', () => {
    assert.equal(llmReviewAll({}), false);
    assert.equal(llmReviewEnabled({}), true);
    assert.equal(llmReviewEnabled({ LLM_REVIEW_ENABLED: 'false' }), false);
    assert.equal(llmReviewEnabled({ LLM_REVIEW_ALL: '1' }), true);
    assert.equal(llmReviewEnabled({ LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_ALL: '1' }), false);
  });

  it('triggers primary review for non-heuristic decisions', () => {
    const on = shouldTriggerLlmReview({
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
      env: {},
    });
    assert.equal(on.trigger, true);
    assert.deepEqual(on.reasons, ['primary_review']);
  });

  it('still skips hard archives when LLM_REVIEW_ALL=1', () => {
    const skipped = shouldTriggerLlmReview({
      heuristic: { hit: true, archiveReason: 'obvious_scam' },
      decision: { action: 'archive', archiveReason: 'obvious_scam' },
      enabled: true,
      env: { LLM_REVIEW_ALL: '1' },
    });
    assert.equal(skipped.trigger, false);
    assert.equal(skipped.skipped, 'hard_archive');
  });

  it('processIncomingMessage calls the LLM on every non-heuristic DM by default', async () => {
    const { createStubJevlikeClient } = require('../stub-jevlike');
    let called = 0;
    const bodies = [];
    const on = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚飲茶？我電話 +852 6123 4567',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'primary-on',
      },
      {
        env: { CONTEXT_LLM_ENABLED: '0' },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            called += 1;
            bodies.push(JSON.parse(opts.body));
            return llmJsonResponse({
              label: 'not_scam',
              should_archive: false,
              confidence: 0.7,
              signals: [],
              reason: 'tea',
            })();
          },
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
      },
    );
    assert.equal(called, 1);
    assert.ok(on.llmTrigger.reasons.includes('primary_review'));
    assert.equal(on.decision.action, 'ignore');
    const user = bodies[0].messages.find((m) => m.role === 'user').content;
    assert.match(user, /XXX/);
    assert.doesNotMatch(user, /6123/);
  });

  it('does not archive when LLM scam confidence is below the threshold', async () => {
    const { createStubJevlikeClient } = require('../stub-jevlike');
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚飲茶？',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'low-conf',
      },
      {
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () =>
            llmJsonResponse({
              label: 'scam',
              should_archive: true,
              confidence: 0.55,
              signals: ['lure'],
              reason: 'weak',
            })(),
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('LLM primary path archives when the LLM says scam', async () => {
    const { createStubJevlikeClient } = require('../stub-jevlike');
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚飲茶？',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'all-raise',
      },
      {
        env: { LLM_REVIEW_ALL: '1', CONTEXT_LLM_ENABLED: '0' },
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () =>
            llmJsonResponse({
              label: 'scam',
              should_archive: true,
              confidence: 0.8,
              signals: ['lure'],
              reason: 'second look',
            })(),
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(reasons, ['llm_review_scam']);
  });
});
