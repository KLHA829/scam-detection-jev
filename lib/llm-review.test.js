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
});

describe('llm triggers', () => {
  it('skips when hard-archived or disabled', () => {
    const grey = {
      score: 41.6,
      label: 'unknown',
      thresholds: rubric.thresholds,
    };
    assert.equal(
      shouldTriggerLlmReview({
        scoreResult: grey,
        text: '今晚傾兩句',
        decision: { action: 'archive', archiveReason: 'lightjev_score' },
        enabled: true,
      }).trigger,
      false,
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
  });

  it('mergeLlmDecision archives only on successful scam/should_archive', () => {
    const ignore = { action: 'ignore', archiveReason: null };
    assert.deepEqual(mergeLlmDecision(ignore, { ok: false, label: 'unknown' }), ignore);
    assert.deepEqual(
      mergeLlmDecision(ignore, {
        ok: true,
        label: 'scam',
        should_archive: true,
      }),
      { action: 'archive', archiveReason: 'llm_review_scam' },
    );
  });

  it('createLlmReviewConfig documents grey defaults', () => {
    const cfg = createLlmReviewConfig({
      LLM_REVIEW_ENABLED: 'true',
      LLM_REVIEW_API_URL: 'http://127.0.0.1:11434/v1',
      LLM_REVIEW_MODEL: 'llama3',
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.greyMin, 0.4);
    assert.equal(cfg.greyMax, 0.85);
    assert.equal(cfg.model, 'llama3');
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

  it('skips LLM when LightJev already hard-archives', async () => {
    let called = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即把驗證碼發給我並轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'hard-1',
      },
      {
        scoreClient: createStubClient('scam'),
        rubric,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            called += 1;
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
    assert.equal(out.decision.archiveReason, 'lightjev_score');
    assert.equal(called, 0);
    assert.equal(out.llmTrigger.trigger, false);
  });
});
