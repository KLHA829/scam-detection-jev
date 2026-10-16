'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createScoreClient, JevlikeClient } = require('./jevlike-client');
const { scoreArchiveReason } = require('./score-message');
const {
  loadRubric,
  scoreMessage,
  jevlikePayloadToScoreResult,
  labelFromScore,
} = require('./score-message');
const { decideIncomingAction } = require('./decide-incoming');
const { processIncomingMessage } = require('./handle-incoming');
const {
  createStubJevlikeClient,
  createStubJevlikeFetch,
  PRESETS,
} = require('../stub-jevlike');

const rubric = loadRubric();

describe('jevlike-only scoring', () => {
  it('createScoreClient always builds a JevlikeClient (SCORER env is ignored)', () => {
    const a = createScoreClient({}, { fetchImpl: async () => {} });
    assert.equal(a instanceof JevlikeClient, true);
    assert.equal(a.scorer, 'jevlike');
    const ignoredV2 = createScoreClient(
      { SCORER: 'model_v2' },
      { fetchImpl: async () => {} },
    );
    assert.equal(ignoredV2 instanceof JevlikeClient, true);
    assert.equal(ignoredV2.scorer, 'jevlike');
    const ignoredLight = createScoreClient(
      { SCORER: 'lightjev' },
      { fetchImpl: async () => {} },
    );
    assert.equal(ignoredLight instanceof JevlikeClient, true);
    assert.equal(ignoredLight.scorer, 'jevlike');
  });
});

describe('jevlike score mapping', () => {
  it('maps P(scam) onto the 0–100 score / archive interface', () => {
    const high = jevlikePayloadToScoreResult(
      { prob_scam: 0.91, prob_not_scam: 0.09 },
      rubric,
    );
    assert.equal(high.scorer, 'jevlike');
    assert.equal(high.archiveReason, 'jevlike_score');
    assert.equal(high.score, 91);
    assert.equal(high.label, 'scam');
    assert.equal(labelFromScore(high.score, rubric.thresholds), 'scam');
    assert.deepEqual(
      decideIncomingAction(high, '85261234567', true, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );

    const low = jevlikePayloadToScoreResult({ prob_scam: 0.04 }, rubric);
    assert.equal(low.score, 4);
    assert.equal(low.label, 'not_scam');
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );

    const mid = jevlikePayloadToScoreResult({ prob_scam: 0.3 }, rubric);
    assert.equal(mid.label, 'unknown');
    assert.equal(scoreArchiveReason(mid), 'jevlike_score');
  });

  it('scoreMessage uses the jevlike stub only', async () => {
    const jev = await scoreMessage('今晚飲茶？', {
      client: createStubJevlikeClient('benign'),
      rubric,
    });
    assert.equal(jev.scorer, 'jevlike');
    assert.equal(jev.ok, true);
    assert.equal(jev.label, 'not_scam');
    assert.ok(jev.score < rubric.thresholds.safe);

    const scam = await scoreMessage('[stub:scam] 請立即轉帳', {
      client: createStubJevlikeClient(),
      rubric,
    });
    assert.equal(scam.label, 'scam');
    assert.equal(scam.archiveReason, 'jevlike_score');
    assert.ok(scam.score >= rubric.thresholds.archive);
  });

  it('fails closed on jevlike timeout without archiving', async () => {
    const result = await scoreMessage('hello', {
      client: {
        scorer: 'jevlike',
        async scoreText() {
          throw new Error('jevlike timeout');
        },
      },
      rubric,
    });
    assert.equal(result.ok, false);
    assert.equal(result.label, 'unknown');
    assert.equal(result.reason, 'jevlike_error');
    assert.deepEqual(
      decideIncomingAction(result, '85261234567', true, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('fails closed on jevlike HTTP 5xx without archiving', async () => {
    const fetch500 = async () =>
      new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
    const client500 = new JevlikeClient({
      baseURL: 'http://127.0.0.1:9',
      apiKey: 'test',
      fetchImpl: fetch500,
      timeoutMs: 500,
    });
    const result = await scoreMessage('hello', { client: client500, rubric });
    assert.equal(result.ok, false);
    assert.equal(result.label, 'unknown');
    assert.equal(result.score, 0);
    assert.equal(result.reason, 'jevlike_error');
    assert.deepEqual(
      decideIncomingAction(result, '85261234567', true, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('JevlikeClient parses /v1/score and retries 429', async () => {
    let n = 0;
    const fetchImpl = async (url, opts) => {
      n += 1;
      assert.match(url, /\/v1\/score$/);
      const body = JSON.parse(opts.body);
      assert.equal(body.text, 'hi');
      if (n === 1) return new Response('slow', { status: 429 });
      return createStubJevlikeFetch(PRESETS.scam)(url, opts);
    };
    const client = new JevlikeClient({
      baseURL: 'http://jevlike.test',
      fetchImpl,
      timeoutMs: 1000,
    });
    const out = await client.scoreText('hi');
    assert.equal(n, 2);
    assert.ok(out.prob_scam > 0.9);
  });
});

describe('decideIncomingAction failed score', () => {
  it('does not archive a failed score that still carries a high number', () => {
    const failed = { ok: false, label: 'unknown', score: 90, thresholds: { archive: 42 } };
    assert.equal(decideIncomingAction(failed, '85261234567', false, { hit: false }).action, 'ignore');
    assert.equal(
      decideIncomingAction(failed, '85261234567', false, {
        hit: true,
        archiveReason: 'obvious_scam',
      }).archiveReason,
      'obvious_scam',
    );
  });
});

describe('processIncomingMessage primary LLM', () => {
  it('archives llm_review_scam when the model flags scam', async () => {
    const { primaryPathDeps, scamLlmFetch } = require('./test-llm');
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'llm-1',
      },
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.equal(out.scoreResult.scorer, 'none');
    assert.deepEqual(reasons, ['llm_review_scam']);
  });
});
