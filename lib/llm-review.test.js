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
  llmReviewEnabled,
  postChatJson,
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

describe('postChatJson response_format fallback cache', () => {
  function optsFor(fetchImpl, extra = {}) {
    return { apiKey: '', timeoutMs: 1000, fetchImpl, ...extra };
  }

  function validCompletionPayload(obj = { label: 'not_scam' }) {
    return JSON.stringify({
      choices: [{ message: { content: JSON.stringify(obj) } }],
    });
  }

  it('caches unsupported response_format after a 400 and successful JSON fallback', async () => {
    const bodies = [];
    const statuses = [400, 200, 200];
    const fetchImpl = async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      const status = statuses.shift() || 200;
      return new Response(status === 200 ? validCompletionPayload() : '{}', { status });
    };
    const url = 'http://llm-cache.test/v1/chat/completions';
    const body = { model: 'model-a', messages: [] };
    const opts = optsFor(fetchImpl);

    await postChatJson(url, body, opts);
    await postChatJson(url, body, opts);

    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
    assert.equal(bodies[1].response_format, undefined);
    assert.equal(bodies[2].response_format, undefined);
  });

  it('isolates the cache by url, model, and fetch implementation', async () => {
    const calls = [];
    const makeFetch = (fetchName) => async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ fetchName, url, body });
      const status = body.response_format ? 400 : 200;
      return new Response(status === 200 ? validCompletionPayload() : '{}', { status });
    };
    const fetchA = makeFetch('fetch-a');
    const fetchB = makeFetch('fetch-b');
    const optsA = optsFor(fetchA);
    const optsB = optsFor(fetchB);
    const urlA = 'http://llm-cache.test/a/v1/chat/completions';
    const urlB = 'http://llm-cache.test/b/v1/chat/completions';

    await postChatJson(urlA, { model: 'model-a', messages: [] }, optsA);
    calls.length = 0;

    await postChatJson(urlA, { model: 'model-a', messages: [] }, optsA);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.response_format, undefined);
    calls.length = 0;

    await postChatJson(urlB, { model: 'model-a', messages: [] }, optsA);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[1].body.response_format, undefined);
    calls.length = 0;

    await postChatJson(urlA, { model: 'model-b', messages: [] }, optsA);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[1].body.response_format, undefined);
    calls.length = 0;

    await postChatJson(urlA, { model: 'model-a', messages: [] }, optsB);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].fetchName, 'fetch-b');
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[1].body.response_format, undefined);
  });

  it('does not cache when the fallback response is not ok', async () => {
    const bodies = [];
    const fetchImpl = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      return new Response(validCompletionPayload(), { status: body.response_format ? 400 : 500 });
    };
    const url = 'http://llm-cache.test/v1/chat/completions';
    const body = { model: 'model-a', messages: [] };
    const opts = optsFor(fetchImpl);

    await postChatJson(url, body, opts);
    await postChatJson(url, body, opts);

    assert.equal(bodies.length, 4);
    assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
    assert.equal(bodies[1].response_format, undefined);
    assert.deepEqual(bodies[2].response_format, { type: 'json_object' });
    assert.equal(bodies[3].response_format, undefined);
  });

  it('does not cache when a 400 fallback returns empty or non-JSON completion text', async () => {
    for (const fallbackBody of [
      '{}',
      JSON.stringify({ choices: [{ message: { content: 'This looks like a scam.' } }] }),
      JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
    ]) {
      const bodies = [];
      const fetchImpl = async (_url, opts) => {
        const body = JSON.parse(opts.body);
        bodies.push(body);
        return new Response(body.response_format ? '{}' : fallbackBody, {
          status: body.response_format ? 400 : 200,
        });
      };
      const url = 'http://llm-cache.test/v1/chat/completions';
      const body = { model: 'model-a', messages: [] };
      const opts = optsFor(fetchImpl);

      await postChatJson(url, body, opts);
      await postChatJson(url, body, opts);

      assert.equal(bodies.length, 4);
      assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
      assert.equal(bodies[1].response_format, undefined);
      assert.deepEqual(bodies[2].response_format, { type: 'json_object' });
      assert.equal(bodies[3].response_format, undefined);
    }
  });

  it('re-probes JSON mode after TTL expiry and recovers when the server enables it', async () => {
    let nowMs = 1_000_000;
    let jsonSupported = false;
    const bodies = [];
    const fetchImpl = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.response_format) {
        if (!jsonSupported) return new Response('{}', { status: 400 });
        return new Response(
          validCompletionPayload({ label: 'scam', confidence: 0.9, signals: [], should_archive: true, reason: 'otp' }),
          { status: 200 },
        );
      }
      return new Response(
        jsonSupported
          ? JSON.stringify({ choices: [{ message: { content: 'This looks like a scam.' } }] })
          : validCompletionPayload({ label: 'not_scam', confidence: 0.9, signals: [], should_archive: false, reason: 'ok' }),
        { status: 200 },
      );
    };
    const url = 'http://llm-cache.test/v1/chat/completions';
    const body = { model: 'model-a', messages: [] };
    const opts = optsFor(fetchImpl, { now: () => nowMs });

    // Initial 400 + valid JSON fallback caches unsupported response_format.
    const first = await postChatJson(url, body, opts);
    assert.equal(parseLlmReview(first.json.choices[0].message.content).label, 'not_scam');
    assert.equal(bodies.length, 2);

    // Server is upgraded behind the same endpoint/model/fetchImpl; within TTL it still uses plain mode.
    jsonSupported = true;
    nowMs += 5 * 60 * 1000;
    const withinTtl = await postChatJson(url, body, opts);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].response_format, undefined);
    assert.equal(parseLlmReview(withinTtl.json.choices[0].message.content).ok, false);

    // After default 30-minute TTL expires, postChatJson re-probes JSON mode and recovers.
    nowMs += 30 * 60 * 1000;
    const recovered = await postChatJson(url, body, opts);
    assert.equal(bodies.length, 4);
    assert.deepEqual(bodies[3].response_format, { type: 'json_object' });
    const parsedRecovered = parseLlmReview(recovered.json.choices[0].message.content);
    assert.equal(parsedRecovered.ok, true);
    assert.equal(parsedRecovered.label, 'scam');

    // Subsequent calls continue using JSON mode directly.
    const next = await postChatJson(url, body, opts);
    assert.equal(bodies.length, 5);
    assert.deepEqual(bodies[4].response_format, { type: 'json_object' });
    assert.equal(parseLlmReview(next.json.choices[0].message.content).label, 'scam');
  });

  it('evicts the oldest unsupported endpoint beyond 256 entries', async () => {
    const requests = [];
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push({ url, body });
      return new Response(body.response_format ? '{}' : validCompletionPayload(), {
        status: body.response_format ? 400 : 200,
      });
    };
    const opts = optsFor(fetchImpl);
    const url = 'http://llm-cache.test/v1/chat/completions';

    for (let i = 0; i < 257; i += 1) {
      await postChatJson(url, { model: `model-${i}`, messages: [] }, opts);
    }
    assert.equal(requests.length, 514);
    requests.length = 0;

    await postChatJson(url, { model: 'model-0', messages: [] }, opts);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
    assert.equal(requests[1].body.response_format, undefined);
    requests.length = 0;

    await postChatJson(url, { model: 'model-256', messages: [] }, opts);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.response_format, undefined);
  });
});

describe('llm triggers', () => {
  for (const label of ['not_scam', 'unknown', 'invalid', null]) {
    it(`merge ignores contradictory non-scam label ${label}`, () => {
      const decision = { action: 'ignore', archiveReason: null };
      assert.deepEqual(mergeLlmDecision(decision, {
        ok: true, label, confidence: 0.9, should_archive: true,
      }, { env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' } }), decision);
    });
  }
  it('triggers primary review for curated malicious hosts and skips only explicit hard archive decisions or disabled review', () => {
    assert.equal(
      shouldTriggerLlmReview({
        decision: { action: 'archive', archiveReason: 'obvious_scam' },
        enabled: true,
      }).skipped,
      'hard_archive',
    );
    assert.equal(
      shouldTriggerLlmReview({
        heuristic: { hit: true, id: 'malicious_host', archiveReason: null },
        decision: { action: 'ignore', archiveReason: null },
        enabled: true,
      }).trigger,
      true,
    );
    assert.equal(
      shouldTriggerLlmReview({
        decision: { action: 'ignore', archiveReason: null },
        enabled: false,
      }).trigger,
      false,
    );
  });

  it('mergeLlmDecision archives on scam above min confidence and keeps primary otherwise', () => {
    const ignore = { action: 'ignore', archiveReason: null };
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
      mergeLlmDecision(ignore, {
        ok: true,
        label: 'not_scam',
        should_archive: false,
      }),
      ignore,
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
      createLlmReviewConfig({ LLM_REVIEW_ALL: '1' }).enabled,
      true,
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
            LLM_REVIEW_MIN_CONFIDENCE: '0.7',
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
        savedContact: false,
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
    assert.match(user, /<PHONE_1>/);
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
        body: '登入 https://malicious-block-test.invalid/login',
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
          fetchImpl: async (_url, opts) => {
            called += 1;
            const sys = JSON.parse(opts.body).messages.find((m) => m.role === 'system').content;
            assert.match(sys, /confirmed malicious-host list/i);
            return llmJsonResponse({
              label: 'scam',
              should_archive: true,
              confidence: 0.95,
              signals: ['malicious_host'],
              reason: 'listed host lure',
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
    assert.equal(heuristicOut.decision.archiveReason, 'llm_review_scam');
    assert.equal(heuristicOut.llmTrigger.trigger, true);
    assert.equal(called, 1);
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
        savedContact: false,
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
      heuristic: { hit: true, id: 'malicious_host', archiveReason: 'obvious_scam' },
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
    assert.match(user, /<PHONE_1>/);
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
        savedContact: false,
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

  it('handles think tags, JSON array payloads, and non-positive timeout env values', () => {
    const withThink = parseLlmReview(
      '<think>looks benign {not json}</think>\n{"label":"not_scam","should_archive":false,"confidence":0.95,"signals":[],"reason":"friend chat"}',
    );
    assert.equal(withThink.ok, true);
    assert.equal(withThink.label, 'not_scam');
    assert.equal(withThink.should_archive, false);

    const arrayReply = parseLlmReview('[]');
    assert.equal(arrayReply.ok, false);

    const zeroTimeout = createLlmReviewConfig({ LLM_REVIEW_TIMEOUT_MS: '0' });
    const negTimeout = createLlmReviewConfig({ LLM_REVIEW_TIMEOUT_MS: '-500' });
    const validTimeout = createLlmReviewConfig({ LLM_REVIEW_TIMEOUT_MS: '2500' });
    assert.ok(zeroTimeout.timeoutMs > 0);
    assert.equal(negTimeout.timeoutMs, zeroTimeout.timeoutMs);
    assert.equal(validTimeout.timeoutMs, 2500);
  });
});

describe('domain facts in the single-message review prompt', () => {
  it('names the official domains in the message in the system prompt', async () => {
    const sent = [];
    const review = (text) => reviewRedactedMessage(text, {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      apiKey: 'sk-test',
      fetchImpl: async (url, opts) => {
        sent.push(JSON.parse(opts.body).messages[0].content);
        return llmJsonResponse({ label: 'not_scam', confidence: 0.1, signals: [], should_archive: false, reason: 'ok' })();
      },
    });
    await review('PayMe 去 https://payme.hsbc/XXX 定 https://hsbc-pay.com/XXX');
    await review('去 www.hsbc.com.hk 或 https://wa.me/XXX');
    await review('聽日見');
    assert.ok(sent[0].endsWith(' Checked on this device: payme.hsbc is the official domain of a known bank, payment service, courier or WhatsApp, not a lookalike. A link on an official domain is not a deceptive or fake page; still judge whether the request itself is a scam.'));
    assert.doesNotMatch(sent[0], /hsbc-pay/);
    assert.match(sent[1], /Checked on this device: www\.hsbc\.com\.hk, wa\.me are official domains of/);
    assert.doesNotMatch(sent[2], /Checked on this device/);
  });

  it('notes a device-detected lookalike without naming its host', async () => {
    let system = '';
    await reviewRedactedMessage('登入 https://<URL_1>/login', {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      heuristic: { hit: true, id: 'lookalike_domain', archiveReason: null },
      fetchImpl: async (_url, opts) => {
        system = JSON.parse(opts.body).messages[0].content;
        return llmJsonResponse({ label: 'scam', confidence: 0.9, signals: [], should_archive: true, reason: 'lookalike' })();
      },
    });
    assert.match(system, /imitates a known .+ but is not the official domain/i);
    assert.doesNotMatch(system, /whatsapp-secure|hsbc\.evil/);
  });
});
