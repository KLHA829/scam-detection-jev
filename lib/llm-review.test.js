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
} = require('./llm-review');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric, aggregateScores, labelFromScore } = require('./score-message');
const { createStubClient, noulMapToAnswers } = require('../stub-lightjev');

const rubric = loadRubric();

function greyNoulMap() {
  return {
    money: 0.67,
    banking: 0.67,
    login_ato: 0.67,
    impersonation: 0.67,
    credential_harvest: 0.67,
    parcel_customs: 0.67,
    prize_job: 0.67,
    crypto_romance: 0.67,
    link_lure: 0.67,
    urgency: 0.67,
  };
}

function highNoulMap() {
  return {
    money: 0.99,
    banking: 0.99,
    login_ato: 0.99,
    impersonation: 0.99,
    credential_harvest: 0.99,
    parcel_customs: 0.99,
    prize_job: 0.99,
    crypto_romance: 0.99,
    link_lure: 0.99,
    urgency: 0.99,
  };
}

const FRIEND_MEAL = '今晚食飯我之後PayMe返你，唔使急';

function llmReviewDeps({ fetchImpl, scoreMap }) {
  return {
    env: { LLM_REVIEW_ENABLED: 'true' },
    scoreClient: createStubClient(() => scoreMap),
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
        decision: { action: 'archive', archiveReason: 'foreign_number' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        scoreResult: high,
        text: '請把驗證碼發給我',
        heuristic: { hit: true, archiveReason: 'obvious_scam' },
        decision: { action: 'archive', archiveReason: 'lightjev_score' },
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
      decision: { action: 'archive', archiveReason: 'lightjev_score' },
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
      decision: { action: 'archive', archiveReason: 'lightjev_score' },
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
      decision: { action: 'archive', archiveReason: 'lightjev_score' },
      enabled: true,
    });
    assert.equal(greyScoreArchive.trigger, true);
    assert.ok(greyScoreArchive.reasons.includes('grey_band'));
    assert.equal(greyScoreArchive.reasons.includes('high_score'), false);
  });

  it('mergeLlmDecision archives on scam, releases score-only archives on not_scam', () => {
    const ignore = { action: 'ignore', archiveReason: null };
    const scoreArchive = { action: 'archive', archiveReason: 'lightjev_score' };
    const foreign = { action: 'archive', archiveReason: 'foreign_number' };
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
      mergeLlmDecision(foreign, {
        ok: true,
        label: 'not_scam',
        should_archive: false,
      }),
      foreign,
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
    const agg = aggregateScores(noulMapToAnswers(greyNoulMap()), rubric);
    assert.ok(agg.score >= 40);
    assert.ok(agg.score < rubric.thresholds.archive);
    assert.equal(labelFromScore(agg.score, rubric.thresholds), 'unknown');

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
        scoreClient: createStubClient(() => greyNoulMap()),
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
    assert.match(user, /\[電話\]/);
    assert.doesNotMatch(user, /6123/);
    assert.doesNotMatch(JSON.stringify(seen[0]), /mapping/);
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
        scoreClient: createStubClient(() => greyNoulMap()),
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

  it('skips LLM on heuristic and foreign-number hard archives', async () => {
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
        scoreClient: createStubClient('benign'),
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

    const foreignOut = await processIncomingMessage(
      {
        type: 'chat',
        body: 'Hi',
        chatId: '14155550123@c.us',
        savedContact: false,
        messageId: 'hard-foreign',
      },
      {
        scoreClient: createStubClient('benign'),
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
          digits: '14155550123',
          unresolvedLid: false,
        }),
        archiveChat: async () => {},
      },
    );
    assert.equal(foreignOut.decision.archiveReason, 'foreign_number');
    assert.equal(foreignOut.llmTrigger.trigger, false);
    assert.equal(called, 0);
  });

  it('releases a high score-only archive when LLM says not_scam', async () => {
    const agg = aggregateScores(noulMapToAnswers(highNoulMap()), rubric);
    assert.ok(agg.score / 100 > 0.85);

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
          scoreMap: highNoulMap(),
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
          scoreMap: highNoulMap(),
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
          scoreMap: highNoulMap(),
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
    assert.equal(unknownOut.decision.archiveReason, 'lightjev_score');
    assert.deepEqual(unknownReasons, ['lightjev_score']);

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
          scoreMap: highNoulMap(),
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
    assert.equal(errorOut.decision.archiveReason, 'lightjev_score');
    assert.deepEqual(errorReasons, ['lightjev_score']);
  });
});
