'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveScorer,
  normalizeScorer,
  createScoreClient,
  clientScorerName,
  scoreArchiveReason,
} = require('./scorer');
const { JevlikeClient } = require('./jevlike-client');
const { LightJevClient } = require('./lightjev-client');
const {
  loadRubric,
  scoreMessage,
  jevlikePayloadToScoreResult,
  labelFromScore,
} = require('./score-message');
const { decideIncomingAction } = require('./decide-incoming');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient, createStubJevlikeFetch, PRESETS } = require('../stub-jevlike');
const { createStubClient } = require('../stub-lightjev');

const rubric = loadRubric();

describe('scorer selection', () => {
  it('defaults to jevlike and maps aliases', () => {
    assert.equal(resolveScorer({}), 'jevlike');
    assert.equal(resolveScorer({ SCORER: '' }), 'jevlike');
    assert.equal(resolveScorer({ SCORER: 'jevlike' }), 'jevlike');
    assert.equal(resolveScorer({ SCORER: 'HF' }), 'jevlike');
    assert.equal(normalizeScorer('model_v2'), 'model_v2');
    assert.equal(resolveScorer({ SCORER: 'model_v2' }), 'model_v2');
    assert.equal(resolveScorer({ SCORER: 'LightJev' }), 'model_v2');
    assert.equal(resolveScorer({ SCORER: 'lightjev' }), 'model_v2');
  });

  it('createScoreClient builds JevlikeClient by default and LightJev for model_v2', () => {
    const a = createScoreClient({ SCORER: 'jevlike' }, { fetchImpl: async () => {} });
    assert.equal(a instanceof JevlikeClient, true);
    assert.equal(a.scorer, 'jevlike');

    const b = createScoreClient({ SCORER: 'model_v2' }, { fetchImpl: async () => {} });
    assert.equal(b instanceof LightJevClient, true);
    assert.equal(b.scorer, 'model_v2');
    assert.equal(clientScorerName(b), 'model_v2');
    assert.equal(clientScorerName(createStubJevlikeClient()), 'jevlike');
    assert.equal(clientScorerName({ systemOne: async () => ({}) }), 'model_v2');
  });
});

describe('jevlike score mapping', () => {
  it('maps P(scam) onto the 0–100 score / archive interface', () => {
    const high = jevlikePayloadToScoreResult({ prob_scam: 0.91, prob_not_scam: 0.09 }, rubric);
    assert.equal(high.scorer, 'jevlike');
    assert.equal(high.archiveReason, 'jevlike_score');
    assert.equal(high.score, 91);
    assert.equal(high.label, 'scam');
    assert.equal(labelFromScore(high.score, rubric.thresholds), 'scam');
    assert.deepEqual(
      decideIncomingAction(high, '85261234567', true, { hit: false }),
      { action: 'archive', archiveReason: 'jevlike_score' },
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

  it('scoreMessage uses jevlike stub vs model_v2 LightJev stub', async () => {
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

    const v2 = await scoreMessage('今晚飲茶？', {
      client: createStubClient('benign'),
      rubric,
      scorer: 'model_v2',
    });
    assert.equal(v2.scorer, 'model_v2');
    assert.equal(v2.archiveReason, 'lightjev_score');
    assert.equal(v2.label, 'not_scam');

    const v2scam = await scoreMessage('請立即把驗證碼發給我並轉帳', {
      client: createStubClient('scam'),
      rubric,
      scorer: 'model_v2',
    });
    assert.equal(v2scam.label, 'scam');
    assert.ok(v2scam.breakdown.length > 1);
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

describe('processIncomingMessage jevlike vs model_v2', () => {
  it('archives jevlike_score for the default scorer', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 請立即轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'jev-1',
      },
      {
        scoreClient: createStubJevlikeClient(),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.equal(out.scoreResult.scorer, 'jevlike');
    assert.deepEqual(reasons, ['jevlike_score']);
  });

  it('keeps lightjev_score when SCORER=model_v2', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即把驗證碼發給我並轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'v2-1',
      },
      {
        scorer: 'model_v2',
        scoreClient: createStubClient('scam'),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.scoreResult.scorer, 'model_v2');
    assert.equal(out.decision.archiveReason, 'lightjev_score');
    assert.deepEqual(reasons, ['lightjev_score']);
  });
});
