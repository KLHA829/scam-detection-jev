'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../scripts/block-log-test-setup');

const { createOperatorState, resolveOperatorMode } = require('./operator-mode');
const { createReviewQueue } = require('./review-queue');
const {
  parseSetupChoice,
  parseReviewChoice,
  localFacts,
  parseGuide,
  buildReviewCard,
  GUIDE_UNAVAILABLE,
} = require('./review-prompt');
const { explainSuspicion } = require('./review-guide');
const { createRecentContext, maskMessagesForLlm } = require('./context-llm');
const { deliverGuidedReview } = require('./deliver-review');
const { applyReviewChoice } = require('./apply-review-choice');
const { routeSelfText, routeVote } = require('./self-chat');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'operator-review-'));
}

describe('operator mode', () => {
  it('keeps automatic handling until a choice is stored', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'operator-mode.json');
    const state = createOperatorState({ env: {}, filePath });
    assert.equal(state.mode(), 'auto');
    assert.equal(state.needsSetup(), true);
    assert.equal(state.awaitingChoice(), true);
    state.rememberSetupPoll('setup-1');
    assert.equal(state.needsSetup(), false);
    assert.equal(state.awaitingChoice(), true);
    assert.equal(state.mode(), 'auto');
    assert.equal(resolveOperatorMode({ env: {}, filePath }).needsSetup, true);

    state.choose('guided');
    assert.equal(state.mode(), 'guided');
    assert.equal(state.needsSetup(), false);
    assert.equal(state.awaitingChoice(), false);
    const again = createOperatorState({ env: {}, filePath });
    assert.equal(again.mode(), 'guided');
    assert.equal(again.needsSetup(), false);
  });

  it('replaces a reconfigure poll when a new initial setup poll is remembered', () => {
    const filePath = path.join(tempDir(), 'operator-mode.json');
    const state = createOperatorState({ env: {}, filePath });
    state.rememberSetupPoll('initial');
    state.rememberReconfigurePoll('reconfigure');
    state.rememberSetupPoll('latest');
    const again = createOperatorState({ env: {}, filePath });
    assert.equal(again.isSetupPoll('initial'), false);
    assert.equal(again.isSetupPoll('reconfigure'), false);
    assert.equal(again.isSetupPoll('latest'), true);
    assert.equal(again.isSetupPoll(null), false);
  });

  it('lets OPERATOR_MODE pin the choice and skip setup', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'operator-mode.json');
    const state = createOperatorState({
      env: { OPERATOR_MODE: 'auto' },
      filePath,
    });
    assert.equal(state.pinned(), true);
    assert.equal(state.needsSetup(), false);
    assert.equal(state.awaitingChoice(), false);
    state.choose('guided');
    assert.equal(state.mode(), 'auto');
  });
});

describe('review choices and local facts', () => {
  it('maps poll labels and numeric replies', () => {
    assert.equal(parseSetupChoice('逐條問我'), 'guided');
    assert.equal(parseSetupChoice('1'), 'auto');
    assert.equal(parseReviewChoice('封鎖並封存'), 'block');
    assert.equal(parseReviewChoice('2'), 'archive');
    assert.equal(parseReviewChoice('3 留低'), 'leave');
    assert.equal(parseReviewChoice('今日食飯'), null);
  });

  it('states the lure and what would have happened', () => {
    const facts = localFacts({
      decision: { action: 'block', archiveReason: 'obvious_scam', heuristicId: 'malicious_host' },
      heuristic: { hit: true, id: 'malicious_host' },
      savedContact: false,
      pushName: '陌生',
      digits: '85290000000',
    });
    assert.doesNotMatch(facts, /封鎖線/);
    assert.match(facts, /惡意域名/);
    assert.match(facts, /原本會封鎖並封存/);
    assert.match(facts, /85290000000/);
  });

  it('drops a guide that repeats an identifier', () => {
    assert.equal(parseGuide('{"guide":"呢句叫你交驗證碼，打去銀行官方電話核實。"}').ok, true);
    assert.equal(parseGuide('{"guide":"打去 91234567"}').ok, false);
    assert.match(buildReviewCard({ facts: '陌生 · 85290000000', guide: null }), new RegExp(GUIDE_UNAVAILABLE));
  });
});

describe('guided explanation', () => {
  it('sends only the desensitised transcript to the chat API', async () => {
    const raw = '我係陳大文 電話 91234567 驗證碼過期請發俾我';
    let sent = null;
    const explained = await explainSuspicion({
      messages: [raw],
      maskClient: createStubJevlikeClient(),
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        apiKey: 'secret',
        fetchImpl: async (_url, opts) => {
          sent = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      guide: '呢句催你交驗證碼。用你自己識嘅官方電話核實，唔好回覆個碼。',
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    });
    assert.equal(explained.skipped, null);
    assert.match(explained.guide, /驗證碼/);
    const user = sent.messages[1].content;
    assert.equal(sent.messages[0].content.includes(raw), false);
    assert.equal(user.includes('91234567'), false);
    assert.equal(user.includes('陳大文'), false);
    assert.match(user, /<NAME_1>/);
    assert.match(user, /<PHONE_1>/);
    assert.equal(JSON.stringify(sent).includes('secret'), false);
  });

  it('tells the model which domains in the transcript are official', async () => {
    let sent = null;
    await explainSuspicion({
      messages: ['麻煩先俾$200訂金，PayMe 去 https://payme.hsbc/repairmaster88'],
      maskClient: { maskMessages: async (m) => ({ messages: m.map((b) => ({ spans: [{ start: b.indexOf('payme.hsbc'), end: b.length }] })) }) },
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (_url, opts) => {
          sent = JSON.parse(opts.body);
          return new Response(JSON.stringify({ choices: [{ message: { content: '{"guide":"x"}' } }] }), { status: 200 });
        },
      },
    });
    assert.match(sent.messages[0].content, /Checked on this device: payme\.hsbc is the official domain/);
    assert.match(sent.messages[1].content, /https:\/\/payme\.hsbc\/<URL_1>/);
  });

  it('keeps the card when the model fails', async () => {
    const explained = await explainSuspicion({
      messages: ['驗證碼過期請發俾我'],
      maskClient: createStubJevlikeClient(),
      env: { LLM_REVIEW_API_URL: '' },
      llmOptions: { apiUrl: '' },
    });
    assert.equal(explained.guide, null);
    assert.equal(explained.skipped, 'missing_api_url');
    assert.match(explained.redacted, /驗證碼/);
  });

  it('masks only uncached unique bodies and reassembles duplicates in order', async () => {
    const cachedBody = '已經睇過嘅句子';
    const repeat = '重複句子';
    const fresh = '新句子';
    const cachedMasked = 'cache masked';
    const maskCache = new Map([[cachedBody, cachedMasked]]);
    const batches = [];
    let sent = null;
    const explained = await explainSuspicion({
      messages: [cachedBody, repeat, fresh, repeat],
      maskCache,
      maskClient: {
        async maskMessages(messages) {
          batches.push([...messages]);
          return { messages: messages.map(() => ({ spans: [] })) };
        },
      },
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (_url, opts) => {
          sent = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '{"guide":"用官方渠道核實。"}' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    });
    assert.equal(explained.skipped, null);
    assert.deepEqual(batches, [[repeat, fresh]]);
    assert.equal(maskCache.get(repeat), repeat);
    assert.equal(maskCache.get(fresh), fresh);
    assert.equal(
      sent.messages[1].content,
      `[1] ${cachedMasked}
[2] ${repeat}
[3] ${fresh}
[4] ${repeat}`,
    );
  });

  it('keeps cached and fresh identifiers distinct in the guided transcript', async () => {
    const recentContext = createRecentContext();
    const chatId = 'guide-token@c.us';
    recentContext.push(chatId, '舊號碼 6123 4567', { messageId: 'guide-token-1' });
    recentContext.push(chatId, '新號碼 9876 5432', { messageId: 'guide-token-2' });
    const maskCache = recentContext.maskCache(chatId);
    const digitSpans = (body) => {
      const spans = [];
      for (const match of body.matchAll(/[0-9+][0-9 ]{5,}/g)) {
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
      return spans;
    };
    const maskClient = {
      async maskMessages(messages) {
        return { messages: messages.map((body) => ({ spans: digitSpans(body) })) };
      },
    };
    const cachedBody = '舊號碼 6123 4567';
    const freshBody = '新號碼 9876 5432';
    const [cachedMasked] = maskMessagesForLlm(
      [cachedBody],
      await maskClient.maskMessages([cachedBody]),
      maskCache.state(),
    );
    maskCache.set(cachedBody, cachedMasked);

    let sent = null;
    const explained = await explainSuspicion({
      messages: [cachedBody, freshBody],
      maskCache,
      maskClient,
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (_url, opts) => {
          sent = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '{"guide":"用官方渠道核實。"}' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    });

    assert.equal(explained.skipped, null);
    const user = sent.messages[1].content;
    const tokens = user.match(/<PHONE_\d+>/g) || [];
    assert.deepEqual([...new Set(tokens)].sort(), ['<PHONE_1>', '<PHONE_2>'], user);
    assert.doesNotMatch(user, /6123|9876/);
  });

  it('fails closed when the empty cached-batch health check errors', async () => {
    const body = '請交驗證碼';
    const batches = [];
    let llmCalled = false;
    const explained = await explainSuspicion({
      messages: [body],
      maskCache: new Map([[body, 'masked body']]),
      maskClient: {
        async maskMessages(messages) {
          batches.push([...messages]);
          throw new Error('PII head unavailable');
        },
      },
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async () => {
          llmCalled = true;
          throw new Error('must not be called');
        },
      },
    });
    assert.equal(explained.skipped, 'mask_failed');
    assert.equal(explained.redacted, null);
    assert.equal(llmCalled, false);
    assert.deepEqual(batches, [[]]);
  });

  it('fails closed when the empty cached-batch health check returns a malformed payload', async () => {
    const body = '請交驗證碼';
    const batches = [];
    let llmCalled = false;
    const explained = await explainSuspicion({
      messages: [body],
      maskCache: new Map([[body, 'masked body']]),
      maskClient: {
        async maskMessages(messages) {
          batches.push([...messages]);
          return {};
        },
      },
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async () => {
          llmCalled = true;
          throw new Error('must not be called');
        },
      },
    });
    assert.equal(explained.skipped, 'mask_failed');
    assert.equal(explained.redacted, null);
    assert.equal(llmCalled, false);
    assert.deepEqual(batches, [[]]);
  });
});

describe('guided delivery and choice', () => {
  it('uses fallback text for malformed guided explanations', async () => {
    for (const guide of [{ reason: 'bad' }, ['bad'], 42, true, null, '', '   ', undefined]) {
      const texts = [];
      const delivered = await deliverGuidedReview({
        result: {
          deferred: true,
          reviewMessages: ['請交驗證碼'],
          decision: { action: 'archive' },
        },
        maskClient: createStubJevlikeClient(),
        env: {},
        llmReview: {
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ guide }) } }],
          })),
        },
        sendText: async (text) => texts.push(text),
        sendPoll: async () => 'poll',
      });
      assert.equal(delivered.pollId, 'poll');
      assert.equal(delivered.guide, null);
      assert.match(texts[0], new RegExp(GUIDE_UNAVAILABLE));
      assert.doesNotMatch(texts[0], /\[object Object\]/);
    }
  });

  it('still offers the poll when the explanation is unavailable', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    const texts = [];
    const delivered = await deliverGuidedReview({
      result: {
        deferred: true,
        messageId: 'm1',
        chatId: '85290000000@c.us',
        formattedNumber: '85290000000',
        savedContact: false,
        pushName: '陌生',
        body: '驗證碼過期請發俾我',
        reviewMessages: ['驗證碼過期請發俾我'],
        decision: {
          action: 'block',
          archiveReason: 'obvious_scam',
          blockReason: 'obvious_scam',
          heuristicId: 'malicious_host',
          contactName: '封鎖·惡意域名',
        },
        heuristic: { hit: true, id: 'malicious_host' },
      },
      maskClient: {
        async maskMessages() {
          throw new Error('mask down');
        },
      },
      llmReview: { apiUrl: 'http://llm.test/v1' },
      env: {},
      queue,
      forward: async () => {},
      sendText: async (text) => {
        texts.push(text);
        return { id: { _serialized: 'card-1' } };
      },
      sendPoll: async () => {
        throw new Error('poll down');
      },
    });
    assert.equal(delivered.pollId, 'card-1');
    assert.match(texts[0], new RegExp(GUIDE_UNAVAILABLE));
    assert.match(texts[0], /惡意域名/);
    assert.doesNotMatch(texts[0], /分數|封存線 \d/);
    assert.equal(queue.get('card-1').resolved, false);
    assert.equal(queue.get('card-1').contactName, '封鎖·惡意域名');
    assert.equal(queue.get('card-1').listName, '陌生');
  });

  it('executes the first choice and ignores a second one', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    queue.add({
      pollId: 'poll-1',
      messageId: 'm1',
      chatId: '85290000000@c.us',
      digits: '85290000000',
      savedContact: true,
      listName: '阿明',
      contactName: '封鎖·惡意域名',
      archiveReason: 'context_llm',
      heuristicId: 'lookalike_domain',
      resolved: false,
    });
    const actions = [];
    const deps = {
      getChat: async (id) => ({ id }),
      getContact: async () => ({ id: 'c' }),
      archiveChat: async () => {
        actions.push('archive');
      },
      blockContact: async ({ contactName }) => {
        actions.push(['block', contactName]);
        return { renamed: false, blocked: true, muted: true, errors: [] };
      },
      recordBlock: async () => {
        actions.push('log');
      },
    };
    const first = await applyReviewChoice(queue.consume('poll-1'), 'block', deps);
    assert.equal(first.ok, true);
    assert.match(first.text, /^已封鎖並封存/);
    assert.match(first.text, /左邊：阿明/);
    assert.match(first.text, /電話：85290000000/);
    assert.doesNotMatch(first.text, /分數|封存線 \d/);
    assert.match(first.text, /假域名/);
    assert.match(first.text, /上文覆核認為要封存/);
    assert.equal(first.text.includes('模型講解'), false);
    assert.deepEqual(actions[0], ['block', null]);
    assert.equal(actions[1], 'archive');
    assert.equal(queue.consume('poll-1'), null);

    const operator = createOperatorState({
      env: {},
      filePath: path.join(dir, 'mode.json'),
    });
    operator.rememberSetupPoll('setup-1');
    assert.deepEqual(
      routeSelfText({ body: '設定', operator, queue }),
      { kind: 'reconfigure' },
    );
    assert.equal(
      routeVote(
        {
          selectedOptions: [{ name: '只封存' }],
          parentMessage: { id: { _serialized: 'poll-1' } },
        },
        { operator, queue },
      ).kind,
      'already',
    );
    assert.equal(
      routeSelfText({
        body: '1',
        quotedId: 'setup-1',
        operator,
        queue,
      }).mode,
      'auto',
    );
  });

  it('passes the context mask cache into the guided explanation', async () => {
    const body = '請交驗證碼';
    const batches = [];
    const delivered = await deliverGuidedReview({
      result: {
        deferred: true,
        reviewMessages: [body],
        decision: { action: 'archive' },
      },
      maskCache: new Map([[body, 'masked body']]),
      maskClient: {
        async maskMessages(messages) {
          batches.push([...messages]);
          return { messages: messages.map(() => ({ spans: [] })) };
        },
      },
      env: {},
      llmReview: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async () => new Response(
          JSON.stringify({ choices: [{ message: { content: '{"guide":"用官方渠道核實。"}' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      },
      sendText: async () => ({ id: { _serialized: 'card-cache' } }),
      sendPoll: async () => ({ id: { _serialized: 'poll-cache' } }),
    });
    assert.deepEqual(batches, [[]]);
    assert.equal(delivered.guide, '用官方渠道核實。');
    assert.equal(delivered.redacted, '[1] masked body');
  });
});

describe('processIncomingMessage guided mode', () => {
  it('does not archive or block, and returns the bodies to desensitise', async () => {
    const { primaryPathDeps } = require('./test-llm');
    const actions = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: '85270000000@c.us',
        savedContact: false,
        pushName: '陌生',
        messageId: 'guided-block',
      },
      primaryPathDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        operatorMode: 'guided',
        maskClient: createStubJevlikeClient('benign'),
        resolveNumber: async () => ({ digits: '85270000000', unresolvedLid: false }),
        archiveChat: async () => {
          actions.push('archive');
        },
        blockContact: async () => {
          actions.push('block');
        },
      }),
    );
    assert.equal(out.deferred, true);
    assert.equal(out.decision.action, 'archive');
    assert.deepEqual(actions, []);
    assert.deepEqual(out.reviewMessages, ['登入 https://whatsapp-secure.com/login']);
    assert.equal(out.formattedNumber, '85270000000');
  });

  it('leaves an ordinary message alone', async () => {
    let archived = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚幾點食飯',
        chatId: '85270000001@c.us',
        savedContact: true,
        messageId: 'guided-benign',
      },
      {
        operatorMode: 'guided',
        maskClient: createStubJevlikeClient('benign'),
        resolveNumber: async () => ({ digits: '85270000001', unresolvedLid: false }),
        archiveChat: async () => {
          archived = true;
        },
      },
    );
    assert.equal(out.deferred, false);
    assert.equal(out.decision.action, 'ignore');
    assert.equal(archived, false);
    assert.deepEqual(out.reviewMessages, []);
  });

  it('returns the bodies after an automatic archive so the receipt can explain them', async () => {
    const { primaryPathDeps } = require('./test-llm');
    const actions = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: '85270000002@c.us',
        savedContact: false,
        pushName: '陌生',
        messageId: 'auto-block',
      },
      primaryPathDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        operatorMode: 'auto',
        maskClient: createStubJevlikeClient('benign'),
        resolveNumber: async () => ({ digits: '85270000002', unresolvedLid: false }),
        archiveChat: async () => {
          actions.push('archive');
        },
        blockContact: async () => {
          actions.push('block');
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      }),
    );
    assert.equal(out.deferred, false);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.blocked, false);
    assert.deepEqual(out.reviewMessages, ['登入 https://whatsapp-secure.com/login']);
    assert.deepEqual(actions, ['archive']);
  });
});

describe('guided delivery when the card send fails', () => {
  it('still offers the poll', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    let polls = 0;
    const delivered = await deliverGuidedReview({
      result: {
        deferred: true,
        messageId: 'm-card',
        chatId: '1@c.us',
        savedContact: false,
        pushName: 'Ada',
        decision: { action: 'archive', archiveReason: 'llm_review_scam' },
        reviewMessages: ['hi'],
      },
      maskClient: {
        async maskMessages() {
          throw new Error('mask down');
        },
      },
      queue,
      sendText: async () => {
        throw new Error('send text down');
      },
      sendPoll: async () => {
        polls += 1;
        return { id: { _serialized: 'poll-card' } };
      },
    });
    assert.equal(polls, 1);
    assert.equal(delivered.pollId, 'poll-card');
    assert.equal(delivered.forwardError, 'send text down');
    assert.equal(queue.get('poll-card').resolved, false);
  });
});

describe('operator block log', () => {
  for (const archiveFails of [false, true]) {
    it(`archives after block throws, archive failure: ${archiveFails}`, async () => {
      const actions = [];
      let logged;
      const result = await applyReviewChoice(
        { chatId: '1@c.us', savedContact: true },
        'block',
        {
          exclusive: async (run) => {
            actions.push('exclusive');
            return run();
          },
          getChat: async () => ({}),
          getContact: async () => ({}),
          blockContact: async ({ contactName }) => {
            assert.equal(contactName, null);
            actions.push('block');
            throw new Error('block failed');
          },
          archiveChat: async () => {
            actions.push('archive');
            if (archiveFails) throw new Error('archive failed');
          },
          recordBlock: async (row) => { logged = row; },
        },
      );
      assert.deepEqual(actions, ['exclusive', 'block', 'archive']);
      assert.equal(result.ok, !archiveFails);
      assert.equal(result.blocked, false);
      assert.equal(logged.blocked, false);
      assert.equal(logged.archived, !archiveFails);
      assert.deepEqual(logged.errors, [
        'block:block failed',
        ...(archiveFails ? ['archive:archive failed'] : []),
      ]);
      assert.match(result.text, archiveFails
        ? /^封鎖未完成，封存未完成/
        : /^封鎖未完成，對話已封存/);
    });
  }

  it('still reports a completed block when the log directory was missing', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'nested', 'blocks.jsonl');
    const result = await applyReviewChoice(
      {
        chatId: '1@c.us',
        savedContact: false,
        score: 90,
        contactName: '封鎖·高分90',
      },
      'block',
      {
        env: { BLOCK_LOG_PATH: missing },
        getChat: async () => ({}),
        archiveChat: async () => {},
        blockContact: async () => ({ blocked: true, renamed: true, muted: true, errors: [] }),
      },
    );
    assert.equal(result.ok, true);
    assert.match(result.text, /^已封鎖並封存/);
    assert.equal(fs.existsSync(missing), true);
  });

  it('keeps the success text when the log write itself throws after a block', async () => {
    const result = await applyReviewChoice(
      { chatId: '1@c.us', savedContact: false, score: 90 },
      'block',
      {
        getChat: async () => ({}),
        archiveChat: async () => {},
        blockContact: async () => ({ blocked: true, renamed: false, muted: true, errors: [] }),
        recordBlock: async () => {
          throw new Error('disk full');
        },
      },
    );
    assert.equal(result.ok, true);
    assert.match(result.text, /^已封鎖並封存/);
    assert.match(result.logError, /disk full/);
  });
});

describe('failed review action stays open', () => {
  for (const archiveFails of [false, true]) {
    it(`keeps a block-failure poll closed only after archive succeeds: ${archiveFails}`, async (t) => {
      const { attachHandlers } = require('../whatsapp-bot');
      const { createActionPacer } = require('./action-pacer');
      const dir = tempDir();
      const blockLog = path.join(dir, 'blocks.jsonl');
      const originalBlockLogPath = process.env.BLOCK_LOG_PATH;
      process.env.BLOCK_LOG_PATH = blockLog;
      t.after(() => {
        if (originalBlockLogPath === undefined) delete process.env.BLOCK_LOG_PATH;
        else process.env.BLOCK_LOG_PATH = originalBlockLogPath;
      });
      const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
      queue.add({ pollId: 'poll-1', chatId: '9@c.us', savedContact: true });
      const sent = [];
      const client = {
        info: { wid: { _serialized: 'me@c.us' } },
        handlers: {},
        on(event, fn) { this.handlers[event] = fn; },
        async sendMessage(_wid, text) { sent.push(text); },
        async getChatById() {
          return {
            async getContact() { return { async block() { throw new Error('block failed'); } }; },
            async archive() { if (archiveFails) throw new Error('archive failed'); },
          };
        },
      };
      attachHandlers(client, {
        operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: queue,
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      });
      const vote = { parentMessage: { id: { _serialized: 'poll-1' } } };
      await client.handlers.vote_update({ ...vote, selectedOptions: [{ name: '封鎖並封存' }] });
      assert.equal(JSON.parse(fs.readFileSync(blockLog, 'utf8').trim()).blocked, false);
      assert.equal(queue.get('poll-1').resolved, !archiveFails);
      assert.match(sent[0], archiveFails ? /^封鎖未完成，封存未完成/ : /^封鎖未完成，對話已封存/);
      assert.equal(sent.length, 1);
      await client.handlers.vote_update({ ...vote, selectedOptions: [{ name: '留低' }] });
      assert.match(sent[1], archiveFails ? /^已留低/ : /^已經處理咗/);
    });
  }

  it('releases the queue item when archive throws', async () => {
    const { attachHandlers } = require('../whatsapp-bot');
    const { createActionPacer } = require('./action-pacer');
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const operator = createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') });
    queue.add({
      pollId: 'poll-1',
      messageId: 'msg-1',
      chatId: '9@c.us',
      savedContact: true,
      resolved: false,
    });
    const sent = [];
    let attempts = 0;
    const client = {
      info: { wid: { _serialized: 'me@c.us' } },
      on(event, fn) {
        this.handlers[event] = fn;
      },
      handlers: {},
      async sendMessage(_wid, text) {
        sent.push(text);
      },
      async getChatById() {
        attempts += 1;
        if (attempts === 1) throw new Error('archive down');
        return { archive: async () => {} };
      },
    };
    attachHandlers(client, {
      operator,
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    });
    const vote = {
      selectedOptions: [{ name: '只封存' }],
      parentMessage: { id: { _serialized: 'poll-1' } },
    };
    await client.handlers.vote_update(vote);
    assert.match(sent[0], /做唔到：archive down/);
    assert.equal(queue.get('poll-1').resolved, false);
    await client.handlers.vote_update(vote);
    assert.match(sent[1], /^已封存，未封鎖/);
    assert.equal(queue.get('poll-1').resolved, true);
  });
});
