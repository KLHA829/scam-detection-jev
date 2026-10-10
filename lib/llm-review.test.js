'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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
    env: { LLM_REVIEW_ENABLED: 'true' },
    scoreClient: createStubJevlikeClient(probScam),
    rubric,
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

  it('parses forced JSON and archives on scam or should_archive', () => {
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
    assert.equal(b.should_archive, true);

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
  it('skips non-score hard archives and disabled review', () => {
    const grey = {
      score: 41.6,
      label: 'unknown',
      thresholds: rubric.thresholds,
    };
    const high = {
      score: 91,
      label: 'scam',
      thresholds: rubric.thresholds,
    };
    assert.equal(
      shouldTriggerLlmReview({
        scoreResult: high,
        text: '今晚食飯我之後PayMe返你',
        formattedNumber: '14155550123',
        savedContact: false,
        decision: { action: 'archive', archiveReason: 'obvious_scam' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        scoreResult: high,
        text: '請把驗證碼發給我',
        heuristic: { hit: true, archiveReason: 'obvious_scam' },
        decision: { action: 'archive', archiveReason: 'jevlike_score' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        scoreResult: grey,
        text: 'template hit',
        rag: { hit: true, archiveReason: 'rag_scam_match' },
        decision: { action: 'archive', archiveReason: 'rag_scam_match' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        scoreResult: grey,
        text: '今晚傾兩句',
        decision: { action: 'ignore', archiveReason: null },
        enabled: false,
      }).trigger,
      false,
    );
  });

  it('fires on score-only high archives when LLM_REVIEW_ON_HIGH is on', () => {
    const high = {
      score: 91,
      label: 'scam',
      thresholds: rubric.thresholds,
    };
    const fired = shouldTriggerLlmReview({
      scoreResult: high,
      text: '今晚食飯我之後PayMe返你，唔使急',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'archive', archiveReason: 'jevlike_score' },
      enabled: true,
      env: { LLM_REVIEW_ON_HIGH: 'true' },
    });
    assert.equal(fired.trigger, true);
    assert.ok(fired.reasons.includes('high_score'));

    const off = shouldTriggerLlmReview({
      scoreResult: high,
      text: '今晚食飯我之後PayMe返你，唔使急',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'archive', archiveReason: 'jevlike_score' },
      enabled: true,
      env: { LLM_REVIEW_ON_HIGH: 'false' },
    });
    assert.equal(off.trigger, false);
    assert.equal(off.skipped, 'no_trigger');
  });

  it('fires on grey band, short OTP, money from unknown number, and conflict', () => {
    const grey = {
      score: 41.6,
      label: 'unknown',
      thresholds: rubric.thresholds,
    };
    const band = shouldTriggerLlmReview({
      scoreResult: grey,
      text: '今晚方便傾兩句嗎？',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
    });
    assert.equal(band.trigger, true);
    assert.ok(band.reasons.includes('grey_band'));

    const otp = shouldTriggerLlmReview({
      scoreResult: { score: 4, label: 'not_scam', thresholds: rubric.thresholds },
      text: '驗證碼：882911',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
    });
    assert.equal(otp.trigger, true);
    assert.ok(otp.reasons.includes('short_otp'));

    const money = shouldTriggerLlmReview({
      scoreResult: { score: 4, label: 'not_scam', thresholds: rubric.thresholds },
      text: '請即刻轉帳3000到此戶口',
      savedContact: false,
      formattedNumber: '85261234567',
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
    });
    assert.equal(money.trigger, true);
    assert.ok(money.reasons.includes('money_unknown_number'));

    const conflict = shouldTriggerLlmReview({
      scoreResult: { score: 4, label: 'not_scam', thresholds: rubric.thresholds },
      heuristic: { hit: false },
      text: '請即刻轉帳3000',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
    });
    assert.equal(conflict.trigger, true);
    assert.ok(conflict.reasons.includes('conflict'));

    const greyScoreArchive = shouldTriggerLlmReview({
      scoreResult: { score: 50, label: 'scam', thresholds: rubric.thresholds },
      text: '今晚方便傾兩句嗎？',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'archive', archiveReason: 'jevlike_score' },
      enabled: true,
    });
    assert.equal(greyScoreArchive.trigger, true);
    assert.ok(greyScoreArchive.reasons.includes('grey_band'));
    assert.equal(greyScoreArchive.reasons.includes('high_score'), false);
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
        should_archive: true,
      }),
      { action: 'archive', archiveReason: 'llm_review_scam' },
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

  it('createLlmReviewConfig documents grey defaults, optional key, and OpenAI aliases', () => {
    const cfg = createLlmReviewConfig({
      LLM_REVIEW_ENABLED: 'true',
      LLM_REVIEW_API_URL: 'http://127.0.0.1:8081/v1',
      LLM_REVIEW_API_KEY: 'local',
      LLM_REVIEW_MODEL: 'Ternary-Bonsai-2-27B',
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.greyMin, 0.4);
    assert.equal(cfg.greyMax, 0.85);
    assert.equal(cfg.reviewOnHigh, true);
    assert.equal(cfg.apiKey, 'local');
    assert.equal(cfg.model, 'Ternary-Bonsai-2-27B');
    assert.equal(
      createLlmReviewConfig({ LLM_REVIEW_ON_HIGH: 'false' }).reviewOnHigh,
      false,
    );
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
        env: { LLM_REVIEW_ENABLED: 'true' },
        scoreClient: createStubJevlikeClient(GREY_PROB),
        rubric,
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
        scoreClient: client,
        rubric,
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
        scoreClient: createStubJevlikeClient(GREY_PROB),
        rubric,
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
        body: '請立即把驗證碼發給我並轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'hard-heuristic',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
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

  it('releases a high score-only archive when LLM says not_scam', async () => {
    assert.ok(HIGH_PROB > 0.85);

    const reasons = [];
    let called = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'high-release',
      },
      {
        ...llmReviewDeps({
          probScam: HIGH_PROB,
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
    assert.ok(out.llmTrigger.reasons.includes('high_score'));
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.released, true);
    assert.equal(out.decision.releaseReason, 'llm_review_not_scam');
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

  it('keeps a high score archive when LLM is unknown or errors', async () => {
    const unknownReasons = [];
    const unknownOut = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'high-unknown',
      },
      {
        ...llmReviewDeps({
          probScam: HIGH_PROB,
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
    assert.equal(unknownOut.decision.action, 'archive');
    assert.equal(unknownOut.decision.archiveReason, 'jevlike_score');
    assert.deepEqual(unknownReasons, ['jevlike_score']);

    const errorReasons = [];
    const errorOut = await processIncomingMessage(
      {
        type: 'chat',
        body: FRIEND_MEAL,
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'high-error',
      },
      {
        ...llmReviewDeps({
          probScam: HIGH_PROB,
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
    assert.equal(errorOut.decision.action, 'archive');
    assert.equal(errorOut.decision.archiveReason, 'jevlike_score');
    assert.deepEqual(errorReasons, ['jevlike_score']);
  });
});

describe('LLM_REVIEW_ALL routing', () => {
  const low = {
    score: 4,
    label: 'not_scam',
    thresholds: rubric.thresholds,
    scorer: 'jevlike',
    archiveReason: 'jevlike_score',
  };

  it('is off by default and does not enable review by itself when 0', () => {
    assert.equal(llmReviewAll({}), false);
    assert.equal(llmReviewEnabled({}), false);
    assert.equal(llmReviewEnabled({ LLM_REVIEW_ALL: '0' }), false);
    assert.equal(llmReviewEnabled({ LLM_REVIEW_ENABLED: 'true' }), true);
    assert.equal(llmReviewEnabled({ LLM_REVIEW_ALL: '1' }), true);
  });

  it('does not review a low-score DM when LLM_REVIEW_ALL=0 (grey-zone path)', () => {
    const off = shouldTriggerLlmReview({
      scoreResult: low,
      text: '今晚飲茶？',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
      env: { LLM_REVIEW_ALL: '0' },
    });
    assert.equal(off.trigger, false);
    assert.equal(off.skipped, 'no_trigger');
  });

  it('reviews every remaining DM when LLM_REVIEW_ALL=1', () => {
    const on = shouldTriggerLlmReview({
      scoreResult: low,
      text: '今晚飲茶？',
      savedContact: true,
      formattedNumber: '85261234567',
      decision: { action: 'ignore', archiveReason: null },
      enabled: true,
      env: { LLM_REVIEW_ALL: '1' },
    });
    assert.equal(on.trigger, true);
    assert.deepEqual(on.reasons, ['review_all']);
  });

  it('still skips hard archives when LLM_REVIEW_ALL=1', () => {
    const skipped = shouldTriggerLlmReview({
      scoreResult: low,
      text: '請立即把驗證碼發給我並轉帳',
      savedContact: true,
      formattedNumber: '85261234567',
      heuristic: { hit: true, archiveReason: 'obvious_scam' },
      decision: { action: 'archive', archiveReason: 'obvious_scam' },
      enabled: true,
      env: { LLM_REVIEW_ALL: '1' },
    });
    assert.equal(skipped.trigger, false);
    assert.equal(skipped.skipped, 'hard_archive');
  });

  it('processIncomingMessage calls the LLM on a benign jevlike score only when ALL=1', async () => {
    const { createStubJevlikeClient } = require('../stub-jevlike');
    let calledOff = 0;
    const off = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚飲茶？',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'all-off',
      },
      {
        env: { LLM_REVIEW_ENABLED: 'true', LLM_REVIEW_ALL: '0' },
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            calledOff += 1;
            return llmJsonResponse({
              label: 'scam',
              should_archive: true,
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
    assert.equal(off.llmTrigger.trigger, false);
    assert.equal(calledOff, 0);
    assert.equal(off.decision.action, 'ignore');

    let calledOn = 0;
    const bodies = [];
    const on = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚飲茶？我電話 +852 6123 4567',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'all-on',
      },
      {
        env: { LLM_REVIEW_ENABLED: 'true', LLM_REVIEW_ALL: '1' },
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            calledOn += 1;
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
    assert.equal(calledOn, 1);
    assert.ok(on.llmTrigger.reasons.includes('review_all'));
    assert.equal(on.decision.action, 'ignore');
    const user = bodies[0].messages.find((m) => m.role === 'user').content;
    assert.match(user, /XXX/);
    assert.doesNotMatch(user, /6123/);
    assert.doesNotMatch(user, /\[電話\]/);
  });

  it('LLM_REVIEW_ALL can archive a jevlike miss when the LLM says scam', async () => {
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
        env: { LLM_REVIEW_ALL: '1' },
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
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
