'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { recentReviewBodies, explainSuspicion } = require('./review-guide');
const {
  optionLabels,
  SETUP_OPTIONS,
  localFacts,
  parseSetupChoice,
} = require('./review-prompt');
const { defaultReviewQueuePath, createReviewQueue } = require('./review-queue');
const { reviewContactName } = require('./deliver-review');
const { defaultOperatorModePath } = require('./operator-mode');
const {
  serializedId,
  messageIdOf,
  parentIdFromVote,
  selectedVoteNames,
  routeSelfText,
  routeVote,
} = require('./self-chat');
const { JevlikeClient, JevlikeError, resolveScoreUrl, parseProbScam } = require('./jevlike-client');
const { createActionPacer } = require('./action-pacer');
const { isLidId } = require('./lid');
const log = require('./log');
const {
  payloadFromProb,
  createStubJevlikeFetch,
  startStubServer,
} = require('../stub-jevlike');
const { defaultBlockLogPath } = require('./block-log');
const { heuristicEnabled } = require('./link-rules');
const { blockEnabled } = require('./block-policy');

const { maskMessagesForLlm } = require('./context-llm');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { loadRubric } = require('./score-message');

const rubric = loadRubric();

describe('review and routing helpers', () => {
  it('keeps the latest guide bodies and names a block contact', () => {
    assert.deepEqual(recentReviewBodies(['  one  ', '', 'two'], ' three '), ['one', 'two', 'three']);
    assert.deepEqual(optionLabels(SETUP_OPTIONS), ['自動封鎖同封存', '逐條問我']);
    assert.equal(parseSetupChoice('逐條問我'), 'guided');
    const facts = localFacts({
      decision: { action: 'archive', archiveReason: 'jevlike_score' },
      savedContact: true,
      pushName: 'Ada',
      digits: '85260000000',
    });
    assert.match(facts, /Ada/);
    assert.doesNotMatch(facts, /分數/);
    assert.equal(
      reviewContactName(
        {
          savedContact: false,
          decision: { contactName: '封鎖·高分90' },
          scoreResult: { score: 90 },
        },
        {},
        rubric,
      ),
      '封鎖·高分90',
    );
    assert.equal(reviewContactName({ savedContact: true }, {}, rubric), null);
  });

  it('routes a self-chat quote and a single poll vote', () => {
    assert.equal(serializedId({ _serialized: 'abc' }), 'abc');
    assert.equal(messageIdOf({ id: 'm1' }), 'm1');
    assert.equal(parentIdFromVote({ parentMessageId: 'poll-9' }), 'poll-9');
    assert.deepEqual(selectedVoteNames({ selectedOptions: [{ name: '只封存' }, '留低'] }), ['只封存', '留低']);
    const queue = createReviewQueue({ filePath: path.join(os.tmpdir(), `audit-q-${process.pid}.json`) });
    queue.add({ pollId: 'poll-9', messageId: 'm', chatId: 'c', resolved: false });
    assert.equal(routeSelfText({ body: '設定' }).kind, 'reconfigure');
    assert.equal(
      routeSelfText({ body: '2', quotedId: 'poll-9', queue }).kind,
      'review',
    );
    assert.equal(
      routeVote(
        { selectedOptions: [{ name: '只封存' }], parentMessage: { id: 'poll-9' } },
        { queue },
      ).choice,
      'archive',
    );
  });
});

describe('mask and score clients', () => {
  it('rejects a mask payload that would leave the text raw', async () => {
    const client = new JevlikeClient({
      baseURL: 'http://mask.test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ messages: [{}] });
        },
      }),
    });
    await assert.rejects(() => client.maskMessages(['電話91234567']), JevlikeError);
    assert.throws(() => maskMessagesForLlm(['電話91234567'], { messages: [{}] }), /incomplete mask/);
    const explained = await explainSuspicion({
      messages: ['電話91234567'],
      maskClient: client,
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async () => {
          throw new Error('should not be called');
        },
      },
      env: {},
    });
    assert.equal(explained.skipped, 'mask_failed');
  });

  it('scores through the stub fetch and the stub server', async () => {
    assert.equal(resolveScoreUrl('http://127.0.0.1:8766/v1/score'), 'http://127.0.0.1:8766/v1/score');
    assert.equal(parseProbScam({ options: ['not_scam', 'scam'], probabilities: [0.2, 0.8] }), 0.8);
    assert.equal(payloadFromProb(0.25).label, 'not_scam');
    const fetchImpl = createStubJevlikeFetch(0.9);
    const res = await fetchImpl('http://127.0.0.1/v1/score', {
      body: JSON.stringify({ text: 'hello' }),
    });
    const json = await res.json();
    assert.equal(json.label, 'scam');

    const server = await startStubServer({ port: 0, preset: 'benign' });
    try {
      const port = server.address().port;
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal((await health.json()).ok, true);
      const scored = await fetch(`http://127.0.0.1:${port}/v1/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal((await scored.json()).label, 'not_scam');
      const masked = await fetch(`http://127.0.0.1:${port}/v1/mask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: ['電話91234567'] }),
      });
      const maskJson = await masked.json();
      assert.ok(Array.isArray(maskJson.messages[0].spans));
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('small pure helpers', () => {
  it('covers paths, pacing, lids, and intent edges', async () => {
    assert.match(defaultReviewQueuePath({ REVIEW_QUEUE_PATH: '/tmp/q.json' }), /q\.json$/);
    assert.match(defaultOperatorModePath({ OPERATOR_MODE_PATH: '/tmp/mode.json' }), /mode\.json$/);
    assert.match(defaultBlockLogPath({ BLOCK_LOG_PATH: '/tmp/blocks.jsonl' }), /blocks\.jsonl$/);
    assert.equal(heuristicEnabled({ HEURISTIC_ENABLED: 'false' }), false);
    assert.equal(blockEnabled({ BLOCK_ENABLED: '0' }), false);
    assert.equal(isLidId('123@lid'), true);

    const lines = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (line) => lines.push(line);
    console.warn = (line) => lines.push(line);
    console.error = (line) => lines.push(line);
    try {
      log.scan('s', { n: 1 });
      log.info('i');
      log.ok('o');
      log.warn('w');
      log.error('e');
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
    assert.deepEqual(
      lines.map((line) => line.slice(0, line.indexOf(' '))),
      ['[SCAN]', '[INFO]', '[OK]', '[WARN]', '[ERROR]'],
    );

    const order = [];
    const pacer = createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } });
    await pacer.exclusive(async () => {
      order.push('a');
    });
    await pacer.exclusive(async () => {
      order.push('b');
    });
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(pacer.gapMs, 0);
  });
});

describe('review-eval script', () => {
  const envWithoutLlmCredentials = () => {
    const env = { ...process.env };
    for (const name of [
      'LLM_REVIEW_API_URL',
      'OPENAI_BASE_URL',
      'OPENAI_API_BASE',
      'LLM_REVIEW_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      delete env[name];
    }
    return env;
  };

  it('scores a tiny labelled file without calling an LLM', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-'));
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        real_test: [
          { label: 1, context: '請把驗證碼發給我 91234567' },
          { label: 0, context: '今晚食飯' },
        ],
      }),
    );
    const out = spawnSync(
      process.execPath,
      [
        'scripts/review-eval.js',
        '--from-run',
        file,
        '--split',
        'real_test',
        '--llm',
        'off',
        '--mode',
        'off',
      ],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /2 \/ 1 \/ 1/);
    assert.match(out.stdout, /stage2 triggered +0 \(0\.0%\)/);
  });

  it('does not call the LLM when --mode is omitted, even with --llm live', () => {
    const out = spawnSync(
      process.execPath,
      ['scripts/review-eval.js', '--llm', 'live'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: envWithoutLlmCredentials() },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /stage2=off \| llm=live/);
    assert.match(out.stdout, /LLM calls made +0\n/);
  });

  for (const [name, extraEnv] of [
    ['without credentials', {}],
    ['with a blank API URL', { LLM_REVIEW_API_URL: '   ' }],
  ]) {
    it(`builds a dry-run request and does not send it ${name}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-dry-'));
      const file = path.join(dir, 'run.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          real_test: [{ label: 1, context: '今晚方便傾兩句嗎？我電話 91234567' }],
        }),
      );
      const out = spawnSync(
        process.execPath,
        [
          'scripts/review-eval.js',
          '--from-run',
          file,
          '--split',
          'real_test',
          '--llm',
          'dry',
          '--mode',
          'all',
        ],
        {
          cwd: path.join(__dirname, '..'),
          encoding: 'utf8',
          env: { ...envWithoutLlmCredentials(), ...extraEnv },
        },
      );
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /dry run/);
      assert.match(out.stdout, /LLM transport failures \(=unknown\) +0\n/);
      assert.match(out.stdout, /建好 1 個 request/);
      assert.match(out.stdout, /XXX/);
      assert.match(out.stdout, /0\/0 {2}\(n\/a\)/);
      assert.doesNotMatch(out.stdout, /NaN/);
    });
  }

  it('rejects the retired triggers mode', () => {
    const out = spawnSync(
      process.execPath,
      ['scripts/review-eval.js', '--mode', 'triggers'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /unsupported --mode triggers; expected off or all/);
  });

  it('refuses an empty split before writing a table', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-empty-'));
    const file = path.join(dir, 'run.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(file, JSON.stringify({ real_test: [] }));
    const out = spawnSync(
      process.execPath,
      [
        'scripts/review-eval.js',
        '--from-run',
        file,
        '--split',
        'real_test',
        '--llm',
        'off',
        '--out',
        outFile,
      ],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /split real_test is empty/);
    assert.equal(fs.existsSync(outFile), false);
  });
});

describe('stub server rejects a bad mask body', () => {
  it('returns 422 for a non-list', async () => {
    const server = await startStubServer({ port: 0 });
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/mask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: 'nope' }),
      });
      assert.equal(res.status, 422);
      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
