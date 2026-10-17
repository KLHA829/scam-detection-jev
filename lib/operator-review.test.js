'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const { deliverGuidedReview } = require('./deliver-review');
const { applyReviewChoice } = require('./apply-review-choice');
const { routeSelfText, routeVote } = require('./self-chat');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

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

  it('states the score, lure, and what would have happened', () => {
    const facts = localFacts({
      scoreResult: { score: 86.2, thresholds: { archive: 42, block: 80 } },
      decision: { action: 'block', archiveReason: 'obvious_scam', heuristicId: 'short_link_solicit' },
      heuristic: { hit: true, id: 'short_link_solicit' },
      savedContact: false,
      pushName: '陌生',
      digits: '85290000000',
      rubric,
    });
    assert.match(facts, /分數 86/);
    assert.match(facts, /封存線 42/);
    assert.doesNotMatch(facts, /封鎖線/);
    assert.match(facts, /短連結索取/);
    assert.match(facts, /原本會封鎖並封存/);
    assert.match(facts, /85290000000/);
  });

  it('drops a guide that repeats an identifier', () => {
    assert.equal(parseGuide('{"guide":"呢句叫你交驗證碼，打去銀行官方電話核實。"}').ok, true);
    assert.equal(parseGuide('{"guide":"打去 91234567"}').ok, false);
    assert.match(buildReviewCard({ facts: '分數 50', guide: null }), new RegExp(GUIDE_UNAVAILABLE));
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
    assert.match(user, /XXX/);
    assert.equal(JSON.stringify(sent).includes('secret'), false);
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
});

describe('guided delivery and choice', () => {
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
        scoreResult: { score: 96, label: 'scam', thresholds: rubric.thresholds },
        decision: {
          action: 'block',
          archiveReason: 'obvious_scam',
          blockReason: 'obvious_scam',
          heuristicId: 'short_link_solicit',
          contactName: '封鎖·短連結索取',
        },
        heuristic: { hit: true, id: 'short_link_solicit' },
      },
      maskClient: {
        async maskMessages() {
          throw new Error('mask down');
        },
      },
      llmReview: { apiUrl: 'http://llm.test/v1' },
      env: {},
      rubric,
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
    assert.match(texts[0], /短連結索取/);
    assert.equal(queue.get('card-1').resolved, false);
    assert.equal(queue.get('card-1').contactName, '封鎖·短連結索取');
    assert.equal(queue.get('card-1').listName, '陌生');
    assert.equal(queue.get('card-1').thresholds.archive, 42);
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
      contactName: '封鎖·高分96',
      score: 96,
      archiveReason: 'jevlike_score',
      heuristicId: 'short_link_solicit',
      thresholds: { archive: 42, block: 80 },
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
    assert.match(first.text, /分數 96/);
    assert.match(first.text, /短連結索取/);
    assert.match(first.text, /評分達到封存線/);
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
});

describe('processIncomingMessage guided mode', () => {
  it('does not archive or block, and returns the bodies to desensitise', async () => {
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
      {
        operatorMode: 'guided',
        maskClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({ digits: '85270000000', unresolvedLid: false }),
        archiveChat: async () => {
          actions.push('archive');
        },
        blockContact: async () => {
          actions.push('block');
        },
      },
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
        rubric,
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
      {
        operatorMode: 'auto',
        maskClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({ digits: '85270000002', unresolvedLid: false }),
        archiveChat: async () => {
          actions.push('archive');
        },
        blockContact: async () => {
          actions.push('block');
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
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
        scoreResult: { score: 50, label: 'scam', ok: true, thresholds: rubric.thresholds },
        decision: { action: 'archive', archiveReason: 'jevlike_score' },
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
