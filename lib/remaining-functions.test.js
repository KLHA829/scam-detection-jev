'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createActionPacer } = require('./action-pacer');
const { applyReviewChoice } = require('./apply-review-choice');
const { TtlCache } = require('./cache');
const {
  contextLlmEnabled,
  contextLlmMessageLimit,
  parseContextReview,
  reviewMaskedTranscript,
  reviewOpeningMessages,
  maskOneForLlm,
} = require('./context-llm');
const { deliverGuidedReview } = require('./deliver-review');
const { blockAndRename } = require('./wa-actions');
const { processIncomingMessage } = require('./handle-incoming');
const { matchObviousScam } = require('./link-rules');
const { JevlikeClient, parseProbScam } = require('./jevlike-client');
const { extractUrls } = require('./link-rules');
const { phoneFromLidMapping, resolveRealNumber } = require('./lid');
const {
  contentFromChatCompletion,
  reviewRedactedMessage,
} = require('./llm-review');
const log = require('./log');
const { createOperatorState, defaultOperatorModePath } = require('./operator-mode');
const { explainSuspicion } = require('./review-guide');
const { parseGuide } = require('./review-prompt');
const { createReviewQueue, defaultReviewQueuePath } = require('./review-queue');
const { loadRubric, jevlikeMaxChars } = require('./score-message');
const { scoreMessage } = require('../lab/score-message');
const { createStubJevlikeClient, startStubServer } = require('../stub-jevlike');
const { contextTurnsFromEnv } = require('./thread-context');

const rubric = loadRubric();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remaining-'));
}

describe('helpers the decision tests do not call directly', () => {
  it('walks pacing, cache eviction, queue trim, and env edges', async () => {
    assert.equal(contextTurnsFromEnv({ CONTEXT_TURNS: '' }), 4);
    assert.equal(contextTurnsFromEnv({ CONTEXT_TURNS: 'nope' }), 4);
    assert.equal(contextLlmEnabled({}), true);
    assert.equal(contextLlmEnabled({ CONTEXT_LLM_ENABLED: '' }), true);
    assert.equal(contextLlmEnabled({ CONTEXT_LLM_ENABLED: '1' }), true);
    assert.equal(contextLlmEnabled({ CONTEXT_LLM_ENABLED: 'true' }), true);
    assert.equal(contextLlmEnabled({ CONTEXT_LLM_ENABLED: '0' }), false);
    assert.equal(contextLlmEnabled({ CONTEXT_LLM_ENABLED: 'false' }), false);
    assert.equal(contextLlmMessageLimit({}), 10);
    assert.equal(contextLlmMessageLimit({ CONTEXT_LLM_MESSAGES: '' }), 10);
    assert.equal(contextLlmMessageLimit({ CONTEXT_LLM_MESSAGES: '0' }), 10);
    assert.equal(contextLlmMessageLimit({ CONTEXT_LLM_MESSAGES: '3' }), 3);
    assert.equal(defaultOperatorModePath({}), path.join(process.cwd(), 'operator-mode.json'));
    assert.equal(defaultReviewQueuePath({}), path.join(process.cwd(), 'review-queue.json'));
    assert.equal(jevlikeMaxChars(rubric, { JEVLIKE_MAX_CHARS: 'nope' }), 2000);
    assert.equal(contentFromChatCompletion({ content: 'plain' }), 'plain');
    assert.equal(parseProbScam({ options: ['not_scam', 'scam'], probabilities: [0.2, 0.8] }), 0.8);
    assert.equal(parseProbScam({ score: 40 }), 0.4);
    assert.equal(parseProbScam(null), null);
    assert.equal(matchObviousScam('').hit, false);
    assert.equal(matchObviousScam(null).hit, false);
    assert.deepEqual(extractUrls('go https://['), []);
    assert.equal(maskOneForLlm('ab', []), 'ab');
    assert.equal(
      parseContextReview('```json\n{"action":"archive","reason":"x"}\n```').action,
      'archive',
    );
    assert.equal(parseContextReview('no brace').ok, false);
    assert.equal(parseGuide('not json {').ok, false);

    const circular = {};
    circular.self = circular;
    log.info('circular extra', circular);

    const pacer = createActionPacer({ env: { WA_ACTION_GAP_MS: '1' } });
    await pacer.pause();
    await pacer.pause();
    assert.equal(createActionPacer({ env: { WA_ACTION_GAP_MS: '-3' } }).gapMs, 3000);

    const cache = new TtlCache({ ttlMs: 1000, now: () => 0 });
    for (let i = 0; i < 501; i += 1) cache.set(`k${i}`, i);
    assert.equal(cache.get('k500'), 500);

    const dir = tempDir();
    const queuePath = path.join(dir, 'q.json');
    fs.writeFileSync(queuePath, '{');
    const queue = createReviewQueue({ filePath: queuePath });
    assert.equal(queue.get('missing'), null);
    for (let i = 0; i < 501; i += 1) {
      queue.add({
        pollId: `p${i}`,
        messageId: `m${i}`,
        resolved: true,
        resolvedAt: String(i).padStart(4, '0'),
      });
    }
    assert.equal(queue.get('p0'), null);
    assert.ok(queue.get('p500'));

    const operator = createOperatorState({
      env: {},
      filePath: path.join(dir, 'mode.json'),
    });
    operator.rememberSetupPoll('setup-9');
    operator.rememberReconfigurePoll('re-9');
    assert.equal(operator.snapshot().setupPollId, 'setup-9');
    assert.equal(operator.setupPollId(), 'setup-9');
    assert.equal(operator.reconfigurePollId(), 're-9');
  });

  it('covers mask, score, and review failure branches', async () => {
    const badMask = new JevlikeClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messages: [{ spans: [{ start: 1, end: 99 }] }] }),
      }),
    });
    await assert.rejects(() => badMask.maskMessages(['hi']), /incomplete mask/);

    const aborting = new JevlikeClient({
      timeoutMs: 20,
      fetchImpl: (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    await assert.rejects(() => aborting.scoreText('hi'), /timeout/);

    let tries = 0;
    const retry = new JevlikeClient({
      fetchImpl: async () => {
        tries += 1;
        if (tries === 1) {
          return { ok: false, status: 529, text: async () => 'busy' };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ prob_scam: 0.2 }),
        };
      },
    });
    assert.equal((await retry.scoreText('hi')).prob_scam, 0.2);

    const garbage = new JevlikeClient({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not-json' }),
    });
    await assert.rejects(() => garbage.scoreText('hi'), /invalid jevlike/);

    await assert.rejects(() => scoreMessage('hi', {}), /rubric is required/);
    const missing = await scoreMessage('hi', { rubric });
    assert.equal(missing.ok, false);
    const cache = new TtlCache({ ttlMs: 1000 });
    const first = await scoreMessage('今晚食飯', {
      rubric,
      cache,
      cacheKey: 'same',
      client: createStubJevlikeClient(0.1),
    });
    const second = await scoreMessage('今晚食飯', {
      rubric,
      cache,
      cacheKey: 'same',
      client: { scoreText: async () => { throw new Error('should not score'); } },
    });
    assert.equal(second.cached, true);
    assert.equal(second.score, first.score);

    const opened = await reviewOpeningMessages({ messages: ['  ', ''] });
    assert.equal(opened.trigger.skipped, 'empty');
    const noMask = await reviewOpeningMessages({ messages: ['你好'], maskClient: {} });
    assert.equal(noMask.trigger.skipped, 'mask_unavailable');

    let calls = 0;
    const reviewed = await reviewMaskedTranscript('[1] 你好', {
      env: { LLM_REVIEW_API_URL: 'http://127.0.0.1/v1/chat/completions' },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 400, text: async () => '{}' };
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: '{"action":"no_action","reason":"ok"}' } }],
            }),
        };
      },
    });
    assert.equal(reviewed.action, 'no_action');
    const unavailable = await reviewMaskedTranscript('hi', {
      env: { LLM_REVIEW_API_URL: 'http://127.0.0.1/v1' },
      fetchImpl: 'nope',
    });
    assert.equal(unavailable.reason, 'fetch_unavailable');

    const emptyGuide = await explainSuspicion({ messages: [] });
    assert.equal(emptyGuide.skipped, 'empty');
    const noGuideMask = await explainSuspicion({ messages: ['你好'], maskClient: {} });
    assert.equal(noGuideMask.skipped, 'mask_unavailable');
    const httpGuide = await explainSuspicion({
      messages: ['你好'],
      maskClient: createStubJevlikeClient(0.1),
      env: { LLM_REVIEW_API_URL: 'http://127.0.0.1/v1/chat/completions' },
      llmOptions: {
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'down' }),
      },
    });
    assert.equal(httpGuide.skipped, 'llm_http_error');

    const disabled = await reviewRedactedMessage('hi', {
      env: {},
      enabled: false,
      fetchImpl: 'nope',
    });
    assert.equal(disabled.reason, 'disabled');
    const noFetch = await reviewRedactedMessage('hi', {
      env: {
        LLM_REVIEW_ENABLED: 'true',
        LLM_REVIEW_API_URL: 'http://127.0.0.1/v1/chat/completions',
      },
      fetchImpl: 'nope',
    });
    assert.equal(noFetch.reason, 'fetch_unavailable');
    const slowReview = await reviewRedactedMessage('hi', {
      env: {
        LLM_REVIEW_ENABLED: 'true',
        LLM_REVIEW_API_URL: 'http://127.0.0.1/v1/chat/completions',
      },
      timeoutMs: 20,
      fetchImpl: (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    assert.equal(slowReview.reason, 'llm_timeout');

    await assert.rejects(
      () => blockAndRename({ contact: {} }),
      /contact.block unavailable/,
    );

    const leave = await applyReviewChoice({ chatId: 'c' }, 'leave', {});
    assert.equal(leave.ok, true);
    const unknown = await applyReviewChoice({ chatId: 'c' }, 'nope', {});
    assert.equal(unknown.ok, false);
    const noChat = await applyReviewChoice({ chatId: 'c' }, 'archive', {});
    assert.match(noChat.text, /攞唔到/);

    const skipped = await deliverGuidedReview({ result: { deferred: false } });
    assert.equal(skipped.skipped, 'not_deferred');
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({ pollId: 'open', messageId: 'dup', resolved: false });
    const duplicate = await deliverGuidedReview({
      result: { deferred: true, messageId: 'dup' },
      queue,
    });
    assert.equal(duplicate.skipped, 'duplicate');
  });

  it('resolves lid shapes and keeps going after a matcher or archive error', async () => {
    assert.equal(
      phoneFromLidMapping({ pn: { _serialized: '85261112222@c.us' } }),
      '85261112222@c.us',
    );
    assert.equal(
      phoneFromLidMapping({ id: { _serialized: '85260001111@c.us', user: '85260001111' } }),
      '85260001111@c.us',
    );
    const resolved = await resolveRealNumber(
      { getContactLidAndPhone: async () => '85260001111@c.us' },
      '999@lid',
    );
    assert.equal(resolved.digits, '85260001111');
    assert.equal(resolved.unresolvedLid, false);
    const failed = await resolveRealNumber(
      { getContactLidAndPhone: async () => { throw new Error('lookup down'); } },
      '999@lid',
    );
    assert.equal(failed.unresolvedLid, true);
    const blank = await resolveRealNumber(
      { getContactLidAndPhone: async () => 'not-a-phone' },
      '999@lid',
    );
    assert.equal(blank.digits, null);
    const noClient = await resolveRealNumber(null, '999@lid');
    assert.equal(noClient.unresolvedLid, true);
    const noDigits = await resolveRealNumber(null, null, { number: '' });
    assert.equal(noDigits.digits, null);

    const base = {
      fromMe: false,
      isGroup: false,
      type: 'chat',
      isMe: false,
      body: '你好，今晚食飯',
      chatId: 'lock@c.us',
      savedContact: true,
      messageId: 'm-lock',
    };
    const { primaryPathDeps, scamLlmFetch, notScamLlmFetch } = require('./test-llm');
    const deps = primaryPathDeps({
      fetchImpl: scamLlmFetch(),
      archiveChat: async () => {},
    });
    const lid = await processIncomingMessage(
      { ...base, messageId: 'm-lid', chatId: 'lid@c.us', body: '你好' },
      {
        ...deps,
        llmReview: { ...deps.llmReview, fetchImpl: notScamLlmFetch() },
        resolveNumber: async () => ({ digits: null, unresolvedLid: true, source: 'lid' }),
      },
    );
    assert.equal(lid.decision.action, 'ignore');

    const failedArchive = await processIncomingMessage(base, {
      ...deps,
      archiveChat: async () => {
        throw new Error('archive down');
      },
    });
    assert.equal(failedArchive.decision.action, 'archive');
    assert.equal(failedArchive.decision.archiveReason, 'llm_review_scam');
    assert.equal(failedArchive.archived, false);
    const again = await processIncomingMessage(
      { ...base, messageId: 'm-again' },
      deps,
    );
    assert.equal(again.decision.action, 'archive');
  });
});

describe('stub server entry and extra routes', () => {
  it('masks a text field, scores, and rejects bad json', async () => {
    const server = await startStubServer({ port: 0 });
    try {
      const port = server.address().port;
      const masked = await fetch(`http://127.0.0.1:${port}/v1/mask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '電話 91234567' }),
      });
      assert.equal(masked.status, 200);
      const maskBody = await masked.json();
      assert.ok(maskBody.messages[0].spans.length > 0);
      const scored = await fetch(`http://127.0.0.1:${port}/v1/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      });
      assert.equal(scored.status, 200);
      const bad = await fetch(`http://127.0.0.1:${port}/v1/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal(bad.status, 422);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('starts from the stub entrypoint and then exits', async () => {
    const child = spawn(process.execPath, ['stub-jevlike.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, JEVLIKE_PORT: '0' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stub did not listen: ${stderr}`)), 3000);
      child.stderr.on('data', () => {
        if (stderr.includes('stub jevlike listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`stub exited ${code}: ${stderr}`));
      });
    });
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  });
});
