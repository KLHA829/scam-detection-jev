'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../scripts/block-log-test-setup');

const { attachHandlers, handleWaMessage, createWhatsAppClient, puppeteerArgs } = require('../whatsapp-bot');
const { createOperatorState } = require('./operator-mode');
const { createReviewQueue } = require('./review-queue');
const { createActionPacer } = require('./action-pacer');
const { createThreadContext } = require('./thread-context');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { scamLlmFetch, llmChatResponse } = require('./test-llm');
const { createRecentContext } = require('./context-llm');
const { createLlmReviewCooldownStore, isChatLlmCooldownActive } = require('./llm-review-cooldown');
const { createBotContactNames } = require('./bot-contact-names');
const { createUserRestoredChats } = require('./user-restored-chats');
const { contactNameForBlock } = require('./block-policy');

function llmLookalikeReview() {
  return {
    enabled: true,
    apiUrl: 'http://llm.test/v1',
    fetchImpl: async (url, options) => {
      const { messages } = JSON.parse(options.body);
      const scam = messages.some(({ role, content }) =>
        role === 'user' && content.includes('whatsapp-secure.com'),
      );
      return llmChatResponse({
        action: scam ? 'archive' : 'no_action',
        label: scam ? 'scam' : 'not_scam',
        confidence: 0.9,
      })(url, options);
    },
  };
}

function llmScamReview() {
  return {
    enabled: true,
    apiUrl: 'http://llm.test/v1',
    fetchImpl: scamLlmFetch(),
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-handlers-'));
}

function fakeClient() {
  const sent = [];
  const client = {
    info: { wid: { _serialized: 'me@c.us' } },
    handlers: {},
    sent,
    on(event, fn) {
      this.handlers[event] = fn;
    },
    async sendMessage(_wid, body) {
      sent.push(body);
      return { id: { _serialized: `sent-${sent.length}` } };
    },
    async getChatById(id) {
      return {
        id,
        async archive() {},
        async getContact() {
          return { block: async () => {}, id: { _serialized: id } };
        },
      };
    },
  };
  return client;
}

describe('operator setup through the client handlers', () => {
  it('preserves a contact saved during guided vote rename pacing', async (t) => {
    const dir = tempDir();
    const previousLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    t.after(() => {
      if (previousLog === undefined) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = previousLog;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    queue.add({
      pollId: 'review', chatId: '9@c.us', digits: '9',
      contactName: '封鎖·惡意域名', savedContact: false,
    });
    let blocked = false;
    let renameCalled = false;
    let pauses = 0;
    let contact = { isMyContact: false, name: '', async block() { blocked = true; } };
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => { renameCalled = true; };
    client.getChatById = async () => ({
      async getContact() { return contact; },
      async archive() {},
      async mute() {},
    });
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: {
        exclusive: (fn) => fn(),
        async pause() {
          if (++pauses === 2) contact = { ...contact, isMyContact: true, name: 'Alice Chan' };
        },
      },
    });
    await client.handlers.vote_update({
      selectedOptions: [{ name: '封鎖並封存' }],
      parentMessage: { id: { _serialized: 'review' } },
    });
    assert.equal(renameCalled, false);
    assert.equal(blocked, true);
    const [poll] = queue.findOpenUnblock();
    assert.equal(poll.savedContact, true);
    assert.equal(poll.renamed, false);
  });

  it('sends the setup poll, accepts 逐條問我, and reconfigures from 設定', async () => {
    const dir = tempDir();
    const operator = createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') });
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    attachHandlers(client, {
      operator,
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      maskClient: createStubJevlikeClient('benign'),
      llmReview: { enabled: false },
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
    });

    await client.handlers.ready();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(operator.isSetupPoll('sent-2'), true);
    assert.equal(typeof client.sent[1], 'object');

    await client.handlers.vote_update({
      selectedOptions: [{ name: '逐條問我' }],
      parentMessage: { id: { _serialized: 'sent-2' } },
    });
    assert.equal(operator.mode(), 'guided');
    assert.match(String(client.sent.at(-1)), /逐條問你/);

    const self = {
      fromMe: true,
      body: '設定',
      hasQuotedMsg: false,
      async getChat() {
        return { id: { _serialized: 'me@c.us' } };
      },
      async getContact() {
        return { isMe: true };
      },
    };
    await client.handlers.message_create(self);
    assert.match(String(client.sent[3]), /再揀一次/);
    assert.equal(operator.isSetupPoll('sent-5'), true);
  });

  it('ignores superseded setup polls and keeps the current poll valid after restart', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'mode.json');
    let operator = createOperatorState({ env: {}, filePath });
    const client = fakeClient();
    const reviewQueue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const attach = () => attachHandlers(client, { operator, reviewQueue });
    const vote = (id, name) => client.handlers.vote_update({
      parentMessage: { id: { _serialized: id } },
      selectedOptions: [{ name }],
    });
    const reconfigure = () => client.handlers.message_create({
      fromMe: true,
      body: '設定',
      hasQuotedMsg: false,
      async getChat() { return { id: { _serialized: 'me@c.us' } }; },
      async getContact() { return { isMe: true }; },
    });
    attach();
    await client.handlers.ready();
    await new Promise((resolve) => setImmediate(resolve));
    const initial = operator.setupPollId();
    await vote(initial, '逐條問我');
    assert.equal(operator.mode(), 'guided');
    await reconfigure();
    const superseded = operator.reconfigurePollId();
    await reconfigure();
    const current = operator.reconfigurePollId();
    operator = createOperatorState({ env: {}, filePath });
    attach();
    const sentBefore = client.sent.length;
    await vote(initial, '1');
    await vote(superseded, '1');
    await vote(null, '1');
    await vote(current, 'invalid');
    await client.handlers.vote_update({ parentMessageId: current, selectedOptions: [] });
    assert.equal(operator.mode(), 'guided');
    assert.equal(client.sent.length, sentBefore);
    await vote(current, '1');
    assert.equal(operator.mode(), 'auto');
    operator = createOperatorState({ env: {}, filePath });
    attach();
    await vote(initial, '逐條問我');
    assert.equal(operator.mode(), 'auto');
    await vote(current, '逐條問我');
    assert.equal(operator.mode(), 'guided');
  });

  it('tells a pinned operator that the mode cannot be changed from chat', async () => {
    const dir = tempDir();
    const operator = createOperatorState({
      env: { OPERATOR_MODE: 'auto' },
      filePath: path.join(dir, 'mode.json'),
    });
    const client = fakeClient();
    attachHandlers(client, {
      operator,
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    });
    await client.handlers.message_create({
      fromMe: true,
      body: '設定',
      hasQuotedMsg: false,
      async getChat() {
        return { id: { _serialized: 'me@c.us' } };
      },
      async getContact() {
        return { isMe: true };
      },
    });
    assert.match(String(client.sent.at(-1)), /釘死/);
  });
});

describe('handleWaMessage', () => {
  it('alerts on suspicious saved contacts without acting until the operator votes', async (t) => {
    const cases = [
      { name: 'listed lure in automatic mode', body: '登入 https://wsd-gov.com 交費', rule: 'obvious_scam' },
      { name: 'listed lure before setup', body: '登入 https://wsd-gov.com 交費', rule: 'obvious_scam', setup: true },
      { name: 'single-message model false positive', body: '今晚返屋企食飯', rule: 'llm_review_scam', primary: true },
      { name: 'context model verdict', body: '請把驗證碼發給我', rule: 'context_llm' },
      { name: 'context confirms a lookalike', body: '登入 https://hsbc.evil.com/login', rule: 'context_llm', heuristicId: 'lookalike_domain' },
      { name: 'primary confirms a soliciting short link', body: '請把驗證碼發給我 https://bit.ly/otp', rule: 'llm_review_scam', primary: true, heuristicId: 'short_link_solicit' },
      { name: 'context rejects a lookalike', body: '登入 https://hsbc.evil.com/login', benign: true, heuristicId: 'lookalike_domain' },
      { name: 'benign model verdict', body: '今晚返屋企食飯', benign: true },
    ];
    for (const { name, body, rule, setup, primary, benign, heuristicId } of cases) {
      await t.test(name, async (st) => {
        const dir = tempDir();
        st.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const client = fakeClient();
        const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
        const events = [];
        const id = { _serialized: '85260001111@c.us' };
        const chat = { id, archive: async () => { events.push('archive'); } };
        const contact = { id, isMyContact: true, name: 'Ada', block: async () => { events.push('block'); } };
        client.getChatById = async () => chat;
        const deps = {
          client,
          reviewQueue: queue,
          pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
          operator: createOperatorState({
            env: setup ? {} : { OPERATOR_MODE: 'auto' },
            filePath: path.join(dir, 'mode.json'),
          }),
          env: { CONTEXT_LLM_ENABLED: primary ? '0' : '1', LLM_REVIEW_MIN_CONFIDENCE: '0.7', LLM_REVIEW_COOLDOWN_MS: '0' },
          maskClient: createStubJevlikeClient(),
          llmReview: {
            ...llmScamReview(),
            fetchImpl: benign
              ? llmChatResponse({ action: 'no_action', confidence: 0.9 })
              : scamLlmFetch({ action: 'archive' }),
          },
        };
        attachHandlers(client, deps);
        const message = {
          type: 'chat', body, id: { _serialized: 'saved-dm' },
          getChat: async () => chat, getContact: async () => contact,
          forward: async (to) => { events.push(`forward:${to}`); },
        };
        const out = await handleWaMessage(message, deps);
        st.diagnostic(`before vote: deferred=${out.deferred}, archived=${out.archived}, blocked=${out.blocked}, self-chat sends=${client.sent.length}`);
        assert.equal(out.archived, false);
        assert.equal(out.blocked, false);
        if (heuristicId) {
          assert.equal(out.heuristic.id, heuristicId);
          assert.equal(out.llmTrigger.trigger, true);
          assert.ok(out.redacted);
        }
        if (benign) {
          assert.equal(out.deferred, false);
          assert.deepEqual(events, []);
          assert.deepEqual(client.sent, []);
          return;
        }
        assert.equal(out.deferred, true);
        assert.equal(out.decision.archiveReason, rule);
        assert.deepEqual(events, ['forward:me@c.us']);
        assert.equal(client.sent.length, 2);
        assert.match(client.sent[0], /已儲存聯絡人.+等你決定/);
        assert.deepEqual(client.sent[1].pollOptions.map(({ name: option }) => option), ['封鎖並封存', '只封存', '留低']);
        assert.equal(queue.get('sent-2').savedContact, true);
        await client.handlers.vote_update({
          selectedOptions: [{ name: '只封存' }],
          parentMessage: { id: { _serialized: 'sent-2' } },
        });
        assert.deepEqual(events, ['forward:me@c.us', 'archive']);
      });
    }
  });

  it('reviews forwarded warnings quoting a blocklisted URL without weakening lure blocks', async (t) => {
    const url = 'https://wsd-gov.com';
    const warning = `屋苑防騙提示：以下係假水務署網站 ${url} ，千萬唔好登入或付款，請提醒屋企長者。`;
    const cases = [
      { name: 'forwarded warning, default context review', action: 'ignore' },
      { name: 'scam site framing reaches masked review', body: 'This is a scam site wsd-gov.com, do not visit.', action: 'ignore' },
      { name: 'forwarded warning, single-message review', primary: true, action: 'ignore' },
      { name: 'explicit warning before the quoted bare host', body: 'Scam alert: Do not visit wsd-gov.com; this is a phishing site.', action: 'ignore' },
      { name: 'quoted URL, guided mode', body: `防騙提醒：假網站「${url}」，切勿點擊。`, guided: true, action: 'ignore' },
      { name: 'indented quote on its own line', body: `防騙提醒：假網站：\n          「${url}」\n          ，切勿點擊。`, action: 'ignore' },
      { name: 'punctuation before the quoted URL', body: `防騙提醒：假網站，${url} ，切勿點擊。`, action: 'ignore' },
      { name: 'warning joined to the URL by a fullwidth comma', body: `防騙提醒：假網站：${url}/pay，切勿點擊。`, action: 'ignore' },
      { name: 'model block verdict only archives', verdict: 'block', action: 'archive' },
      { name: 'mask failure does not block or archive', maskFails: true, action: 'ignore' },
      { name: 'forwarded lure', body: `水費逾期，請立即登入 ${url} 付款。`, action: 'block' },
      { name: 'fake framing with billing update still blocks', body: `Fake site. Please update the billing details ${url}`, action: 'block' },
      { name: 'negated advice before a separate login request still blocks', body: `Never click fake links. Log in at ${url}`, action: 'block' },
      { name: 'anti-scam authority impersonation without explicit ask', body: `反詐騙協調中心通知：你嘅戶口涉及詐騙案，詳情見 ${url}`, action: 'block' },
      { name: 'anti-scam website notice still blocks unsaved sender', body: `反詐騙協調中心網站 ${url} 幫你追回款項`, action: 'block' },
      { name: 'anti-scam noun prefix still blocks unsaved sender', body: `反詐騙網站 ${url} 幫你追回款項`, action: 'block' },
      { name: 'prevention website entrance still blocks unsaved sender', body: `預防詐騙網站入口 ${url}`, action: 'block' },
      { name: 'warning heading alone does not excuse a lure', body: `【防騙提示】你嘅戶口涉及詐騙案，詳情見 ${url}`, action: 'block' },
      { name: 'warning followed by a payment request', body: `${warning} 請立即付款。`, action: 'block' },
      { name: 'warning followed by a second link', body: `${warning} 請登入 ${url}/pay`, action: 'block' },
      { name: 'warning followed by a repeat of the URL', body: `${warning} ${url}`, action: 'block' },
      { name: 'joined warning followed by a payment request', body: `防騙提醒：假網站：${url}/pay，切勿點擊。 請付款。`, action: 'block' },
      { name: 'warning without forward metadata', isForwarded: false, action: 'ignore' },
      { name: 'saved contact receives masked review', saved: true, action: 'ignore' },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async (st) => {
        const { body = warning, isForwarded = true, primary, saved = false, verdict = 'no_action', maskFails } = scenario;
        const calls = [];
        const client = fakeClient();
        client.info = null;
        client.saveOrEditAddressbookContact = async () => {};
        const digits = '85261112222';
        const jid = `${digits}@c.us`;
        const chat = {
          id: { _serialized: jid },
          async archive() { calls.push('archive'); },
          async mute() { calls.push('mute'); },
        };
        const contact = {
          id: { _serialized: jid, user: digits },
          isMyContact: saved,
          number: digits,
          async block() { calls.push('block'); },
        };
        let sentToModel;
        const out = await handleWaMessage({
          type: 'chat', body, isForwarded, from: jid,
          async getChat() { return chat; },
          async getContact() { return contact; },
        }, {
          client,
          pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
          operator: scenario.guided ? { mode: () => 'guided', awaitingChoice: () => false } : undefined,
          env: {
            ...(primary && { CONTEXT_LLM_ENABLED: '0' }),
            LLM_REVIEW_COOLDOWN_MS: '0',
            LLM_REVIEW_MIN_CONFIDENCE: '0.7',
            BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
          },
          maskClient: {
            async maskMessages() {
              calls.push('mask');
              if (maskFails) throw new Error('test mask failure');
              return { messages: [{ spans: [{ start: 0, end: 2 }] }] };
            },
          },
          llmReview: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            async fetchImpl(_url, options) {
              calls.push('AI');
              sentToModel = JSON.parse(options.body).messages.at(-1).content;
              return llmChatResponse({
                action: verdict, label: 'not_scam', confidence: 0.9, should_archive: false, reason: 'test',
              })();
            },
          },
        });
        st.diagnostic(`${out.decision.action}; ${out.llmTrigger.skipped || 'reviewed'}; calls: ${calls.join(' → ')}`);
        assert.equal(out.decision.action, scenario.action);
        if (scenario.action === 'block') {
          assert.equal(out.llmTrigger.skipped, 'hard_archive');
          assert.deepEqual(calls, ['block', 'mute', 'archive']);
        } else if (maskFails) {
          assert.equal(out.llmTrigger.skipped, 'mask_failed');
          assert.deepEqual(calls, ['mask']);
        } else {
          assert.equal(out.llmReview.ok, true);
          assert.deepEqual(calls, verdict === 'block' ? ['mask', 'AI', 'archive'] : ['mask', 'AI']);
          const shown = primary ? body.slice(2) : body.slice(2).replace(/\s*\n\s*/g, ' ');
          assert.ok(sentToModel.includes(`XXX${shown}`));
        }
      });
    }
  });

  it('archives when the LLM flags scam and ignores a group', async () => {
    const archived = [];
    const client = fakeClient();
    const chat = {
      isGroup: false,
      id: { _serialized: '85260001111@c.us' },
      async archive() {
        archived.push('archive');
      },
      async mute() {},
    };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Ada',
      name: 'Ada',
      id: { _serialized: '85260001111@c.us', user: '85260001111' },
      number: '85260001111',
    };
    const msg = {
      fromMe: false,
      body: '請把驗證碼發給我',
      type: 'chat',
      from: '85260001111@c.us',
      id: { _serialized: 'msg-high' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
    };
    const out = await handleWaMessage(msg, {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      env: { CONTEXT_LLM_ENABLED: '0' },
      maskClient: createStubJevlikeClient(0.96),
      llmReview: llmScamReview(),
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'auto' },
        filePath: path.join(tempDir(), 'mode.json'),
      }),
      reviewQueue: null,
    });
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(archived, ['archive']);
    assert.match(String(client.sent.at(-1)), /已封存，未封鎖/);

    const failedChatId = '85260001112@c.us';
    const failed = await handleWaMessage(
      {
        ...msg,
        from: failedChatId,
        id: { _serialized: 'msg-archive-fail' },
        async getChat() {
          return {
            ...chat,
            id: { _serialized: failedChatId },
            async archive() {
              throw new Error('archive down');
            },
          };
        },
        async getContact() {
          return {
            ...contact,
            id: { _serialized: failedChatId, user: '85260001112' },
            number: '85260001112',
          };
        },
      },
      {
        client,
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        env: { CONTEXT_LLM_ENABLED: '0' },
        maskClient: createStubJevlikeClient(0.96),
        llmReview: llmScamReview(),
        operator: createOperatorState({
          env: { OPERATOR_MODE: 'auto' },
          filePath: path.join(tempDir(), 'mode-fail.json'),
        }),
        reviewQueue: null,
      },
    );
    assert.equal(failed.archived, false);
    assert.match(String(client.sent.at(-1)), /封存未完成/);

    const group = await handleWaMessage(
      {
        ...msg,
        async getChat() {
          return { ...chat, isGroup: true };
        },
      },
      {
        client,
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        maskClient: createStubJevlikeClient(0.96),
        llmReview: { enabled: false },
        operator: null,
        reviewQueue: null,
      },
    );
    assert.equal(group.ignored, true);
  });

  it('blocks an unsaved lure and forwards a guided review', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => {};
    const events = [];
    const chat = {
      isGroup: false,
      id: { _serialized: '85261112222@c.us' },
      async archive() {
        events.push('archive');
      },
      async mute() {
        events.push('mute');
      },
    };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Stranger',
      name: 'Stranger',
      id: { _serialized: '85261112222@c.us', user: '85261112222' },
      number: '85261112222',
      async block() {
        events.push('block');
      },
    };
    const msg = {
      fromMe: false,
      body: '登入 https://malicious-block-test.invalid/login',
      type: 'chat',
      from: '85261112222@c.us',
      id: { _serialized: 'msg-block' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
      async forward() {
        events.push('forward');
      },
    };
    const blocked = await handleWaMessage(msg, {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient(0.05),
      llmReview: { enabled: false },
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'auto' },
        filePath: path.join(dir, 'auto.json'),
      }),
      reviewQueue: queue,
    });
    assert.equal(blocked.decision.action, 'block');
    assert.deepEqual(events, ['block', 'mute', 'archive']);

    events.length = 0;
    const guided = await handleWaMessage(
      { ...msg, id: { _serialized: 'msg-guided' } },
      {
        client,
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        maskClient: createStubJevlikeClient(0.05),
        llmReview: { enabled: false },
        operator: createOperatorState({
          env: { OPERATOR_MODE: 'guided' },
          filePath: path.join(dir, 'guided.json'),
        }),
        reviewQueue: queue,
      },
    );
    assert.equal(guided.deferred, true);
    assert.equal(events.includes('block'), false);
    assert.equal(events.includes('forward'), true);
    const open = Object.values(JSON.parse(fs.readFileSync(queue.path, 'utf8')).items);
    assert.equal(open.some((item) => item.messageId === 'msg-guided' && !item.resolved), true);
  });

  it('archives without block when a message is edited into a lookalike link', async () => {
    const events = [];
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => {};
    const chat = {
      isGroup: false,
      id: { _serialized: '85261113333@c.us' },
      async archive() {
        events.push('archive');
      },
      async mute() {
        events.push('mute');
      },
    };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Stranger',
      name: 'Stranger',
      id: { _serialized: '85261113333@c.us', user: '85261113333' },
      number: '85261113333',
      async block() {
        events.push('block');
      },
    };
    const msg = {
      fromMe: false,
      body: 'hi',
      type: 'chat',
      from: '85261113333@c.us',
      id: { _serialized: 'msg-edit' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
    };
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient(0.05),
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      llmReview: llmLookalikeReview(),
      operator: null,
      reviewQueue: null,
    });
    await client.handlers.message_edit(msg, 'hi', 'hi');
    assert.deepEqual(events, []);
    await client.handlers.message_edit(msg, '登入 https://whatsapp-secure.com/login', 'hi');
    assert.equal(msg.body, '登入 https://whatsapp-secure.com/login');
    assert.deepEqual(events, ['archive']);
  });

  it('voids the guided poll when its message is edited to something harmless', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    const archived = [];
    client.getChatById = async (id) => ({
      id,
      async archive() {
        archived.push(id);
      },
    });
    const chat = {
      isGroup: false,
      id: { _serialized: '85261114444@c.us' },
      async archive() {
        archived.push('auto');
      },
    };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Stranger',
      name: 'Stranger',
      id: { _serialized: '85261114444@c.us', user: '85261114444' },
      number: '85261114444',
    };
    const msg = {
      fromMe: false,
      body: '登入 https://whatsapp-secure.com/login',
      type: 'chat',
      from: '85261114444@c.us',
      id: { _serialized: 'msg-edited-guided' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
      async forward() {},
    };
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient(0.05),
      cache: null,
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      llmReview: llmLookalikeReview(),
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'guided' },
        filePath: path.join(dir, 'mode.json'),
      }),
      reviewQueue: queue,
    });

    await client.handlers.message(msg);
    const poll = queue.findOpenByMessageId('msg-edited-guided');
    assert.ok(poll, 'guided poll sent for the original text');

    await client.handlers.message_edit(msg, 'Hello', msg.body);
    assert.equal(queue.findOpenByMessageId('msg-edited-guided'), null);

    await client.handlers.vote_update({
      selectedOptions: [{ name: '只封存' }],
      parentMessage: { id: { _serialized: poll.pollId } },
    });
    assert.deepEqual(archived, []);
    assert.match(String(client.sent.at(-1)), /作廢/);

    await client.handlers.message_edit(msg, '登入 https://whatsapp-secure.com/login', 'Hello');
    const fresh = queue.findOpenByMessageId('msg-edited-guided');
    assert.ok(fresh && fresh.pollId !== poll.pollId, 'a fresh poll for the new text');
  });

  it('delivers a guided review and honors its archive vote when cooldown saving fails', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parent = path.join(dir, 'not-a-directory');
    fs.writeFileSync(parent, '');
    const env = { CONTEXT_LLM_ENABLED: '0', LLM_REVIEW_COOLDOWN_MS: '600000' };
    const store = createLlmReviewCooldownStore({ filePath: path.join(parent, 'cooldown.json'), env });
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    const chatId = '85261117777@c.us';
    const messageId = 'msg-cooldown-save-failed';
    const events = [];
    const chat = {
      isGroup: false,
      id: { _serialized: chatId },
      async archive() { events.push('archive'); },
    };
    client.getChatById = async () => chat;
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env,
      maskClient: createStubJevlikeClient('benign'),
      llmReview: llmScamReview(),
      llmCooldownStore: store,
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'guided' },
        filePath: path.join(dir, 'mode.json'),
      }),
      reviewQueue: queue,
    });
    await client.handlers.message({
      fromMe: false,
      body: '請把驗證碼發給我',
      type: 'chat',
      from: chatId,
      id: { _serialized: messageId },
      getChat: async () => chat,
      getContact: async () => ({ isMe: false, isMyContact: false, id: chat.id }),
      async forward() { events.push('forward'); },
    });

    assert.deepEqual(events, ['forward'], 'forward the message without archiving before the vote');
    const poll = queue.findOpenByMessageId(messageId);
    assert.ok(poll, 'queue the review poll');
    assert.equal(typeof client.sent[0], 'string', 'send a review card');
    assert.ok(client.sent[1].pollOptions.some(({ name }) => name === '只封存'));
    assert.equal(isChatLlmCooldownActive(chatId, env, { store }), true);

    await client.handlers.vote_update({
      selectedOptions: [{ name: '只封存' }],
      parentMessage: { id: { _serialized: poll.pollId } },
    });
    assert.deepEqual(events, ['forward', 'archive']);
  });

  it('re-reviews an edited model-flagged DM on retry after a queue save failure', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const store = createLlmReviewCooldownStore();
    const env = { CONTEXT_LLM_ENABLED: '0', LLM_REVIEW_COOLDOWN_MS: '600000' };
    const client = fakeClient();
    const chat = { isGroup: false, id: { _serialized: '85261115555@c.us' }, async archive() {} };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Stranger',
      name: 'Stranger',
      id: { _serialized: '85261115555@c.us', user: '85261115555' },
      number: '85261115555',
    };
    const msg = {
      fromMe: false,
      body: '請把驗證碼發給我',
      type: 'chat',
      from: '85261115555@c.us',
      id: { _serialized: 'msg-edited-model' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
      async forward() {},
    };
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      env,
      maskClient: createStubJevlikeClient(0.05),
      cache: null,
      llmReview: llmScamReview(),
      llmCooldownStore: store,
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'guided' },
        filePath: path.join(dir, 'mode.json'),
      }),
      reviewQueue: queue,
    });

    await client.handlers.message(msg);
    const poll = queue.findOpenByMessageId('msg-edited-model');
    assert.ok(poll, 'guided poll sent for the model-flagged text');
    assert.ok(isChatLlmCooldownActive(chat.id._serialized, env, { store }));

    const original = msg.body;
    const edited = '請即刻把驗證碼發給我';
    const tmp = `${queue.path}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    await client.handlers.message_edit(msg, edited, original);
    const resolvedInMemory = queue.get(poll.pollId).resolved;
    const resolvedOnDisk = createReviewQueue({ filePath: queue.path }).get(poll.pollId).resolved;

    fs.rmdirSync(tmp);
    const getChatById = t.mock.method(client, 'getChatById');
    await client.handlers.vote_update({
      selectedOptions: [{ name: '只封存' }],
      parentMessage: { id: { _serialized: poll.pollId } },
    });
    assert.equal(getChatById.mock.callCount(), 0, 'a stale vote must not act once storage recovers');
    assert.match(String(client.sent.at(-1)), /作廢/);

    await client.handlers.message_edit(msg, edited, original);
    const fresh = queue.findOpenByMessageId('msg-edited-model');
    assert.deepEqual({
      resolvedInMemory,
      resolvedOnDisk,
      freshPollOnRetry: !!fresh && fresh.pollId !== poll.pollId,
    }, {
      resolvedInMemory: false,
      resolvedOnDisk: false,
      freshPollOnRetry: true,
    });
    const persisted = createReviewQueue({ filePath: queue.path });
    assert.equal(persisted.get(poll.pollId).voidReason, 'edited');
    assert.equal(persisted.findOpenByMessageId('msg-edited-model').pollId, fresh.pollId);
  });

  it('never publishes a saved-contact poll from a model verdict superseded by an edit', async (t) => {
    for (const context of [false, true]) {
      await t.test(context ? 'two rapid context edits' : 'single primary edit', async (st) => {
        await checkSupersededVerdict(st, context);
      });
    }
  });

  async function checkSupersededVerdict(t, context) {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    const chatId = '85261115555@c.us';
    const messageId = 'saved-edited-during-review';
    const actions = [];
    const contact = {
      isMyContact: true,
      id: { _serialized: chatId, user: '85261115555' },
      number: '85261115555',
    };
    const msg = {
      body: '請把驗證碼發給我',
      type: 'chat',
      from: chatId,
      id: { _serialized: messageId },
      async getChat() {
        return { id: { _serialized: chatId }, async archive() { actions.push('archive'); } };
      },
      async getContact() { return contact; },
      async forward() { actions.push('forward'); },
    };
    let startReview;
    let finishReview;
    const reviewStarted = new Promise((resolve) => { startReview = resolve; });
    const reviewFinished = new Promise((resolve) => { finishReview = resolve; });
    const reviewed = [];
    const recentContext = context ? createRecentContext() : null;
    const threadContext = createThreadContext({ turns: 4 });
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { CONTEXT_LLM_ENABLED: context ? '1' : '0' },
      recentContext,
      threadContext,
      maskClient: createStubJevlikeClient(0.05),
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        async fetchImpl(url, init) {
          const { messages } = JSON.parse(init.body);
          const text = messages.at(-1).content;
          reviewed.push(text);
          if (reviewed.length === 1) {
            startReview();
            await reviewFinished;
            return scamLlmFetch({ action: 'archive' })(url, init);
          }
          return llmChatResponse(context
            ? { action: text.includes('驗證碼') ? 'archive' : 'no_action', confidence: 0.9 }
            : { label: 'not_scam', confidence: 0.9 })();
        },
      },
      llmCooldownStore: createLlmReviewCooldownStore(),
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'auto' },
        filePath: path.join(dir, 'mode.json'),
      }),
      reviewQueue: queue,
    });

    const original = client.handlers.message(msg);
    await reviewStarted;
    const firstEdit = context
      ? client.handlers.message_edit({ ...msg }, 'Middle edit', msg.body)
      : null;
    const edited = client.handlers.message_edit({ ...msg }, 'Hello', context ? 'Middle edit' : msg.body);
    finishReview();
    await Promise.all([original, firstEdit, edited]);

    assert.deepEqual(client.sent, []);
    assert.deepEqual(actions, []);
    assert.equal(queue.findOpenByMessageId(messageId), null);
    assert.equal(reviewed.length, 2);
    assert.match(reviewed[1], /Hello/);
    assert.doesNotMatch(reviewed[1], /驗證碼|Middle edit/);
    assert.deepEqual(threadContext.prior(chatId), ['Hello']);
    if (context) assert.deepEqual(recentContext.recent(chatId), [{ fromMe: false, body: 'Hello' }]);
  }

  it('does not let the context review re-flag the original text after a harmless edit', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    const chat = { isGroup: false, id: { _serialized: '85261116666@c.us' }, async archive() {} };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Stranger',
      name: 'Stranger',
      id: { _serialized: '85261116666@c.us', user: '85261116666' },
      number: '85261116666',
    };
    const msg = {
      fromMe: false,
      body: '請把驗證碼發給我',
      type: 'chat',
      from: '85261116666@c.us',
      id: { _serialized: 'msg-edited-context' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
      async forward() {},
    };
    const fetchImpl = async (url, init) =>
      llmChatResponse(
        String(init && init.body).includes('驗證碼')
          ? { action: 'archive', confidence: 0.9, reason: 'test' }
          : { action: 'no_action', confidence: 0.9, reason: 'test' },
      )();
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: createRecentContext({ limit: 10 }),
      env: { CONTEXT_LLM_ENABLED: '1' },
      maskClient: createStubJevlikeClient(0.05),
      cache: null,
      llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl },
      llmCooldownStore: createLlmReviewCooldownStore(),
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'guided' },
        filePath: path.join(dir, 'mode.json'),
      }),
      reviewQueue: queue,
    });

    await client.handlers.message(msg);
    assert.ok(queue.findOpenByMessageId('msg-edited-context'), 'context review flagged the original');

    await client.handlers.message_edit(msg, 'Hello', msg.body);
    assert.equal(queue.findOpenByMessageId('msg-edited-context'), null);
  });
});

describe('createWhatsAppClient', () => {
  it('builds a client without starting the browser', () => {
    const client = createWhatsAppClient();
    assert.equal(typeof client.initialize, 'function');
    assert.equal(typeof client.on, 'function');
  });

  it('turns the sandbox off for root or an explicit override', () => {
    assert.deepEqual(puppeteerArgs(0), [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]);
    assert.deepEqual(puppeteerArgs(1000), ['--disable-dev-shm-usage']);
    assert.deepEqual(puppeteerArgs(1000, true), [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]);
  });

  it('keeps an explicit browser path on the client options', () => {
    const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = '/tmp/chrome-for-test';
    try {
      const client = createWhatsAppClient();
      assert.equal(client.options.puppeteer.executablePath, '/tmp/chrome-for-test');
    } finally {
      if (previous == null) delete process.env.PUPPETEER_EXECUTABLE_PATH;
      else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
    }
  });
});

describe('remaining client handlers', () => {
  function selfMessage(body, extra = {}) {
    return {
      fromMe: true,
      body,
      hasQuotedMsg: false,
      async getChat() {
        return { id: { _serialized: 'me@c.us' } };
      },
      async getContact() {
        return { isMe: true };
      },
      ...extra,
    };
  }

  it('logs session events and applies a quoted review', async () => {
    const dir = tempDir();
    const operator = createOperatorState({
      env: { OPERATOR_MODE: 'guided' },
      filePath: path.join(dir, 'mode.json'),
    });
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'poll-1',
      messageId: 'm1',
      chatId: '85260001111@c.us',
      savedContact: true,
      resolved: false,
    });
    const client = fakeClient();
    const archived = [];
    client.getChatById = async (id) => ({
      id,
      async archive() {
        archived.push(id);
      },
      async getContact() {
        return { id: { _serialized: id } };
      },
    });
    attachHandlers(client, {
      operator,
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    });

    await client.handlers.qr('qr-data');
    await client.handlers.authenticated();
    await client.handlers.auth_failure('bad session');
    await client.handlers.disconnected('logout');

    await client.handlers.vote_update({
      selectedOptions: [{ name: '只封存' }],
      parentMessage: { id: { _serialized: 'poll-1' } },
    });
    assert.deepEqual(archived, ['85260001111@c.us']);
    assert.match(String(client.sent.at(-1)), /已封存/);

    await client.handlers.vote_update({
      selectedOptions: [{ name: '留低' }],
      parentMessage: { id: { _serialized: 'poll-1' } },
    });
    assert.match(String(client.sent.at(-1)), /已經處理/);

    queue.add({
      pollId: 'poll-2',
      messageId: 'm2',
      chatId: '85260002222@c.us',
      savedContact: false,
      contactName: '封鎖·高分90',
      resolved: false,
    });
    await client.handlers.message_create(
      selfMessage('留低', {
        hasQuotedMsg: true,
        async getQuotedMessage() {
          return { id: { _serialized: 'poll-2' } };
        },
      }),
    );
    assert.match(String(client.sent.at(-1)), /已留低/);
    assert.equal(queue.get('poll-2').resolved, true);
  });

  it('applies a quoted review choice transcribed from a Cantonese voice note', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'voice-review',
      messageId: 'm-voice',
      chatId: '85260003333@c.us',
      savedContact: true,
      resolved: false,
    });
    const client = fakeClient();
    const archived = [];
    client.getChatById = async (id) => ({
      id,
      async archive() {
        archived.push(id);
      },
      async getContact() {
        return { id: { _serialized: id } };
      },
    });
    const mediaCalls = [];
    attachHandlers(client, {
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { VOICE_COMMANDS_ENABLED: '1' },
      voiceCommandClient: {
        async transcribeMedia(media, options) {
          mediaCalls.push({ media, options });
          return '唔好封。';
        },
      },
    });

    await client.handlers.message_create(selfMessage('', {
      type: 'ptt',
      hasQuotedMsg: true,
      async getQuotedMessage() {
        return { id: { _serialized: 'voice-review' } };
      },
      async downloadMedia() {
        return { data: 'b2dn', mimetype: 'audio/ogg' };
      },
    }));

    assert.equal(mediaCalls.length, 1);
    assert.equal(mediaCalls[0].options.context, '封佢, 封鎖佢, 唔好封, 只封存');
    assert.deepEqual(archived, []);
    assert.equal(queue.get('voice-review').resolved, true);
    assert.match(String(client.sent.at(-1)), /已留低/);
  });

  it('runs a direct unblock command transcribed from a Cantonese voice note', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'blocks.jsonl');
    const prevLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = logPath;
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'voice-unblock',
      kind: 'unblock',
      chatId: '85294444444@c.us',
      digits: '85294444444',
      contactName: '封鎖·域名',
      blockContactName: '封鎖·域名',
      renamed: true,
      savedContact: false,
      resolved: false,
      createdAt: new Date().toISOString(),
    });
    const client = fakeClient();
    let unblocked = false;
    client.deleteAddressbookContact = async () => {};
    client.getChatById = async (id) => ({
      id,
      async getContact() {
        return {
          name: '封鎖·域名',
          async unblock() {
            unblocked = true;
          },
        };
      },
    });
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { VOICE_COMMANDS_ENABLED: 'true' },
      voiceCommandClient: {
        async transcribeMedia() {
          return '解封';
        },
      },
    });

    await client.handlers.message_create(selfMessage('', {
      type: 'ptt',
      async downloadMedia() {
        return { data: 'b2dn', mimetype: 'audio/ogg' };
      },
    }));

    assert.equal(unblocked, true);
    assert.equal(queue.get('voice-unblock').resolved, true);
    assert.match(String(client.sent.at(-1)), /仍然封存/);

    if (prevLog == null) delete process.env.BLOCK_LOG_PATH;
    else process.env.BLOCK_LOG_PATH = prevLog;
  });

  it('ignores a hallucinated multi-command transcript instead of guessing', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'voice-review-hallucinated',
      messageId: 'm-voice-hallucinated',
      chatId: '85260003333@c.us',
      savedContact: true,
      resolved: false,
    });
    const client = fakeClient();
    attachHandlers(client, {
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { VOICE_COMMANDS_ENABLED: 'true' },
      voiceCommandClient: {
        async transcribeMedia() {
          return '封佢，唔好封，只封存。';
        },
      },
    });

    await client.handlers.message_create(selfMessage('', {
      type: 'ptt',
      hasQuotedMsg: true,
      async getQuotedMessage() {
        return { id: { _serialized: 'voice-review-hallucinated' } };
      },
      async downloadMedia() {
        return { data: 'b2dn', mimetype: 'audio/ogg' };
      },
    }));

    assert.equal(queue.get('voice-review-hallucinated').resolved, false);
    assert.equal(client.sent.length, 0);
  });

  it('does not transcribe a self-chat audio attachment as a voice command', async () => {
    const dir = tempDir();
    const client = fakeClient();
    let transcribeCalls = 0;
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { VOICE_COMMANDS_ENABLED: 'true' },
      voiceCommandClient: {
        async transcribeMedia() {
          transcribeCalls += 1;
          return '解封';
        },
      },
    });

    await client.handlers.message_create(selfMessage('', {
      type: 'audio',
      async downloadMedia() {
        return { data: 'b2dn', mimetype: 'audio/mpeg' };
      },
    }));

    assert.equal(transcribeCalls, 0);
    assert.equal(client.sent.length, 0);
  });

  it('does not act when voice transcription fails', async () => {
    const dir = tempDir();
    const client = fakeClient();
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { VOICE_COMMANDS_ENABLED: '1' },
      voiceCommandClient: {
        async transcribeMedia() {
          throw new Error('asr down');
        },
      },
    });

    await client.handlers.message_create(selfMessage('', {
      type: 'ptt',
      async downloadMedia() {
        return { data: 'b2dn', mimetype: 'audio/ogg' };
      },
    }));

    assert.match(String(client.sent.at(-1)), /語音指令暫時轉唔到文字/);
  });

  it('refuses a pinned setup vote and survives a failed send', async () => {
    const dir = tempDir();
    const modePath = path.join(dir, 'mode.json');
    fs.writeFileSync(modePath, JSON.stringify({ setupPollId: 'old-setup', mode: 'guided' }));
    const operator = createOperatorState({
      env: { OPERATOR_MODE: 'auto' },
      filePath: modePath,
    });
    const client = fakeClient();
    attachHandlers(client, {
      operator,
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    });
    await client.handlers.vote_update({
      selectedOptions: [{ name: '逐條問我' }],
      parentMessage: { id: { _serialized: 'old-setup' } },
    });
    assert.match(String(client.sent.at(-1)), /釘死/);
    assert.equal(operator.mode(), 'auto');

    client.sendMessage = async () => {
      throw new Error('send down');
    };
    await client.handlers.message_create(selfMessage('設定'));
    await client.handlers.message({
      async getChat() {
        throw new Error('no chat');
      },
    });
    await client.handlers.message_create(
      selfMessage('設定', {
        async getChat() {
          throw new Error('no self');
        },
      }),
    );
  });

  it('handles operator text commands only in self chat', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'blocks.jsonl');
    const prevLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = logPath;
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'ub-cmd',
      kind: 'unblock',
      chatId: '85294444444@c.us',
      digits: '85294444444',
      contactName: '封鎖·域名',
      blockContactName: '封鎖·域名',
      renamed: true,
      savedContact: false,
      resolved: false,
      createdAt: new Date().toISOString(),
    });
    const client = fakeClient();
    let deletedPhone = null;
    client.deleteAddressbookContact = async (phone) => {
      deletedPhone = phone;
    };
    let unblocked = false;
    client.getChatById = async (id) => ({
      id,
      async getContact() {
        return {
          name: '封鎖·域名',
          async unblock() {
            unblocked = true;
          },
        };
      },
    });
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    });

    await client.handlers.message_create(
      selfMessage('幫助', {
        async getChat() {
          return { id: { _serialized: '85299998888@c.us' } };
        },
        async getContact() {
          return { isMe: false };
        },
      }),
    );
    assert.equal(client.sent.length, 0);

    await client.handlers.message_create(
      selfMessage('解除', {
        async getChat() {
          return { id: { _serialized: '85299998888@c.us' } };
        },
        async getContact() {
          return { isMe: true };
        },
      }),
    );
    assert.equal(unblocked, false);
    assert.equal(client.sent.length, 0);
    assert.equal(queue.get('ub-cmd').resolved, false);

    await client.handlers.message_create(selfMessage('幫助'));
    assert.match(String(client.sent.at(-1)), /自我對話指令/);

    await client.handlers.message_create(selfMessage('解除'));
    assert.equal(unblocked, true);
    assert.equal(deletedPhone, '85294444444');
    assert.match(String(client.sent.at(-1)), /仍然封存/);
    assert.equal(queue.get('ub-cmd').resolved, true);

    if (prevLog == null) delete process.env.BLOCK_LOG_PATH;
    else process.env.BLOCK_LOG_PATH = prevLog;
  });

  for (const scenario of [
    { name: 'own LID', wid: 'me@c.us', chatId: '123@lid', mappings: [{ pn: 'me@c.us', lid: '123@lid' }], accepted: true },
    { name: 'own phone with LID wid', wid: '123@lid', chatId: 'me@c.us', mappings: [{ pn: 'me@c.us', lid: '123@lid' }], accepted: true },
    { name: 'direct LID wid', wid: '123@lid', chatId: '123@lid', accepted: true },
    { name: 'another LID', chatId: '999@lid', mappings: [{ pn: 'me@c.us', lid: '123@lid' }], accepted: false },
    { name: 'unrelated mapping', chatId: '999@lid', mappings: [{ pn: 'other@c.us', lid: '999@lid' }], accepted: false },
    { name: 'empty mapping', chatId: '123@lid', mappings: [], accepted: false },
    { name: 'missing mapping API', chatId: '123@lid', accepted: false },
    { name: 'failed mapping', chatId: '123@lid', mappingError: true, accepted: false },
  ]) {
    it(`checks self-chat identity: ${scenario.name}`, async () => {
      const dir = tempDir();
      const client = fakeClient();
      client.info.wid._serialized = scenario.wid || 'me@c.us';
      if (scenario.mappings || scenario.mappingError) {
        client.getContactLidAndPhone = async (ids) => {
          assert.deepEqual(ids, [client.info.wid._serialized]);
          if (scenario.mappingError) throw new Error('lookup down');
          return scenario.mappings;
        };
      }
      attachHandlers(client, {
        operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      });
      await client.handlers.message_create(selfMessage('幫助', {
        async getChat() {
          return { id: { _serialized: scenario.chatId } };
        },
        async getContact() {
          throw new Error('sender identity must not be consulted');
        },
      }));
      assert.equal(client.sent.length, scenario.accepted ? 1 : 0);
      if (scenario.accepted) assert.match(String(client.sent[0]), /自我對話指令/);
    });
  }

  it('forwards the poll block name when confirming an unblock', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'ub-vote',
      kind: 'unblock',
      chatId: '85294444444@c.us',
      digits: '85294444444',
      contactName: '封鎖·域名',
      blockContactName: '封鎖·域名',
      resolved: false,
    });
    const client = fakeClient();
    let deletedPhone = null;
    let unblocked = false;
    client.deleteAddressbookContact = async (phone) => {
      deletedPhone = phone;
    };
    client.getChatById = async (id) => ({
      id,
      async getContact() {
        return {
          name: '封鎖·域名',
          async unblock() {
            unblocked = true;
          },
        };
      },
    });
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    });

    await client.handlers.vote_update({
      selectedOptions: [{ name: '解除封鎖' }],
      parentMessage: { id: { _serialized: 'ub-vote' } },
    });

    assert.equal(unblocked, true);
    assert.equal(deletedPhone, '85294444444');
    assert.equal(queue.get('ub-vote').resolved, true);
  });

  it('stores block rename metadata on the automatic unblock poll', async () => {
    const dir = tempDir();
    const previousLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    try {
      const chatId = '85260009999@c.us';
      const events = [];
      const client = fakeClient();
      client.saveOrEditAddressbookContact = async () => {
        events.push('rename');
      };
      const operator = createOperatorState({
        env: { OPERATOR_MODE: 'auto' },
        filePath: path.join(dir, 'mode.json'),
      });
      const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
      const host = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../data/malicious-hosts.json'), 'utf8'),
      ).hosts[0];
      const chat = {
        id: { _serialized: chatId },
        isGroup: false,
        async archive() {
          events.push('archive');
        },
        async mute() {
          events.push('mute');
        },
      };
      const contact = {
        id: { _serialized: chatId, user: '85260009999' },
        number: '85260009999',
        isMyContact: false,
        isMe: false,
        name: 'Stranger',
        pushname: 'Stranger',
        async block() {
          events.push('block');
        },
      };
      const result = await handleWaMessage(
        {
          fromMe: false,
          body: `登入 https://${host}/login`,
          type: 'chat',
          from: chatId,
          id: { _serialized: 'auto-block-message' },
          _data: { notifyName: 'Stranger' },
          async getChat() {
            return chat;
          },
          async getContact() {
            return contact;
          },
        },
        {
          client,
          pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
          threadContext: createThreadContext({ turns: 2 }),
          recentContext: null,
          maskClient: createStubJevlikeClient('benign'),
          llmReview: { enabled: false },
          operator,
          reviewQueue: queue,
        },
      );
      assert.equal(result.blocked, true);
      assert.equal(result.renamed, true);
      assert.equal(result.savedContact, false);
      assert.deepEqual(events, ['block', 'rename', 'mute', 'archive']);
      const [poll] = queue.findOpenUnblock();
      assert.equal(poll.renamed, true);
      assert.equal(poll.savedContact, false);
      const [blockRecord] = fs
        .readFileSync(process.env.BLOCK_LOG_PATH, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(blockRecord.renamed, true);
      assert.equal(blockRecord.savedContact, false);
    } finally {
      if (previousLog == null) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = previousLog;
    }
  });

  it('does not forward a guided review when self chat is missing', async () => {
    const client = fakeClient();
    client.info = {};
    const out = await handleWaMessage(
      {
        fromMe: false,
        body: '登入 https://whatsapp-secure.com/login',
        type: 'chat',
        from: '85261112222@c.us',
        id: { _serialized: 'msg-nowid' },
        async getChat() {
          return {
            isGroup: false,
            id: { _serialized: '85261112222@c.us' },
            async archive() {},
            async mute() {},
          };
        },
        async getContact() {
          return {
            isMyContact: false,
            isMe: false,
            pushname: 'Stranger',
            name: 'Stranger',
            id: { _serialized: '85261112222@c.us', user: '85261112222' },
            number: '85261112222',
            async block() {},
          };
        },
      },
      {
        client,
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        maskClient: createStubJevlikeClient(0.05),
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        llmReview: llmLookalikeReview(),
        operator: createOperatorState({
          env: { OPERATOR_MODE: 'guided' },
          filePath: path.join(tempDir(), 'mode.json'),
        }),
        reviewQueue: createReviewQueue({ filePath: path.join(tempDir(), 'q.json') }),
      },
    );
    assert.equal(out.deferred, true);
    assert.equal(client.sent.length, 0);
  });

  it('blocks from a poll, reports a failed forward, and logs a failed setup', async () => {
    const dir = tempDir();
    const previousLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    try {
    const operator = createOperatorState({
      env: {},
      filePath: path.join(dir, 'mode.json'),
    });
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'poll-block',
      messageId: 'mb',
      chatId: '85261112222@c.us',
      savedContact: false,
      contactName: '封鎖·測試',
      digits: '85261112222',
      resolved: false,
    });
    const client = fakeClient();
    const events = [];
    client.saveOrEditAddressbookContact = async () => {
      events.push('rename');
    };
    client.getChatById = async (id) => ({
      id,
      async archive() {
        events.push('archive');
      },
      async mute() {
        events.push('mute');
      },
      async getContact() {
        return {
          id: { _serialized: id },
          async block() {
            events.push('block');
          },
        };
      },
    });
    attachHandlers(client, {
      operator,
      reviewQueue: queue,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      maskClient: createStubJevlikeClient(0.05),
      llmReview: { enabled: false },
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
    });

    await client.handlers.vote_update({
      selectedOptions: [{ name: '封鎖並封存' }],
      parentMessage: { id: { _serialized: 'poll-block' } },
    });
    assert.deepEqual(events, ['block', 'rename', 'mute', 'archive']);
    const confirmText = client.sent.filter((m) => typeof m === 'string').pop();
    assert.match(String(confirmText), /已封鎖並封存/);
    assert.equal(client.sent.length, 2);
    const openUnblock = Object.values(
      JSON.parse(fs.readFileSync(path.join(dir, 'q.json'), 'utf8')).items,
    ).find((item) => item.kind === 'unblock' && !item.resolved);
    assert.ok(openUnblock);
    assert.equal(openUnblock.renamed, true);
    assert.equal(openUnblock.savedContact, false);

    const guided = await handleWaMessage(
      {
        fromMe: false,
        body: '登入 https://whatsapp-secure.com/login',
        type: 'chat',
        from: '85261113333@c.us',
        id: { _serialized: 'msg-forward-fail' },
        async getChat() {
          return { isGroup: false, id: { _serialized: '85261113333@c.us' } };
        },
        async getContact() {
          return {
            isMyContact: false,
            isMe: false,
            pushname: 'Stranger',
            name: 'Stranger',
            id: { _serialized: '85261113333@c.us', user: '85261113333' },
            number: '85261113333',
          };
        },
        async forward() {
          throw new Error('forward down');
        },
      },
      {
        client,
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        maskClient: createStubJevlikeClient(0.05),
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        llmReview: llmLookalikeReview(),
        operator: createOperatorState({
          env: { OPERATOR_MODE: 'guided' },
          filePath: path.join(dir, 'guided.json'),
        }),
        reviewQueue: queue,
      },
    );
    assert.equal(guided.deferred, true);

    client.sendMessage = async () => {
      throw new Error('setup down');
    };
    await client.handlers.ready();
    await new Promise((resolve) => setImmediate(resolve));
    } finally {
      if (previousLog == null) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = previousLog;
    }
  });
});

describe('process entry', () => {
  it('logs a fatal error when initialize fails', async () => {
    const dir = tempDir();
    const preload = path.join(dir, 'preload.js');
    fs.writeFileSync(
      preload,
      [
        "const Module = require('module');",
        'const orig = Module.prototype.require;',
        'Module.prototype.require = function (id) {',
        '  const exp = orig.apply(this, arguments);',
        "  if (id === 'whatsapp-web.js') {",
        '    exp.Client.prototype.initialize = async () => {',
        "      throw new Error('no browser');",
        '    };',
        '  }',
        '  return exp;',
        '};',
        '',
      ].join('\n'),
    );
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-r', preload, 'whatsapp-bot.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        WA_TRANSPORT: 'wwebjs',
        OPERATOR_MODE: 'auto',
        OPERATOR_MODE_PATH: path.join(dir, 'mode.json'),
        REVIEW_QUEUE_PATH: path.join(dir, 'q.json'),
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`bot entry hung: ${stderr}`));
      }, 5000);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 1);
    assert.match(stderr, /no browser/);
  });
});

describe('main wires the bot without opening Chrome', () => {
  it('returns after a stubbed initialize', async () => {
    const { Client } = require('whatsapp-web.js');
    const { main } = require('../whatsapp-bot');
    const dir = tempDir();
    const previous = {
      WA_TRANSPORT: process.env.WA_TRANSPORT,
      OPERATOR_MODE: process.env.OPERATOR_MODE,
      OPERATOR_MODE_PATH: process.env.OPERATOR_MODE_PATH,
      REVIEW_QUEUE_PATH: process.env.REVIEW_QUEUE_PATH,
    };
    const original = Client.prototype.initialize;
    Client.prototype.initialize = async function stubInitialize() {
      return undefined;
    };
    process.env.WA_TRANSPORT = 'wwebjs';
    process.env.OPERATOR_MODE = 'auto';
    process.env.OPERATOR_MODE_PATH = path.join(dir, 'mode.json');
    process.env.REVIEW_QUEUE_PATH = path.join(dir, 'q.json');
    try {
      assert.equal(await main(), undefined);
    } finally {
      Client.prototype.initialize = original;
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('suspicious pitch label through the client handler', () => {
  it('labels an unsaved pitch sender, and the label does not shield a later scam', async () => {
    const calls = [];
    const client = fakeClient();
    client.info = null;
    const digits = '85261113333';
    const jid = `${digits}@c.us`;
    const chat = {
      id: { _serialized: jid },
      async archive() { calls.push('archive'); },
      async mute() { calls.push('mute'); },
    };
    const contact = {
      id: { _serialized: jid, user: digits },
      isMyContact: false,
      number: digits,
      async block() { calls.push('block'); },
    };
    client.saveOrEditAddressbookContact = async (phone, name) => {
      calls.push(`label:${phone}:${name}`);
      contact.isMyContact = true;
      contact.name = name;
    };
    const deps = {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      botContactNames: createBotContactNames(),
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      maskClient: createStubJevlikeClient(),
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (url, options) => {
          const user = JSON.parse(options.body).messages.find(({ role }) => role === 'user').content;
          const verdict = user.includes('驗證碼')
            ? { action: 'archive', pitch: true, confidence: 0.9 }
            : { action: 'no_action', pitch: true, confidence: 0.6 };
          return llmChatResponse(verdict)(url, options);
        },
      },
    };
    const send = (body, id) => handleWaMessage({
      type: 'chat', body, from: jid, id: { _serialized: id },
      async getChat() { return chat; },
      async getContact() { return contact; },
    }, deps);

    const pitch = await send('王老師帶你炒股，每日穩賺5%，免費入群', 'pitch-1');
    assert.equal(pitch.decision.action, 'label');
    assert.equal(pitch.labelled, true);
    assert.equal(pitch.archived, false);
    assert.deepEqual(calls, [`label:${digits}:（可疑推銷）`]);

    const again = await send('今日又賺咗3%，快啲入群', 'pitch-2');
    assert.equal(again.savedContact, false);
    assert.equal(again.labelled, false);
    assert.deepEqual(calls, [`label:${digits}:（可疑推銷）`]);

    const scam = await send('入群前請把驗證碼發給我', 'pitch-3');
    assert.equal(scam.savedContact, false);
    assert.equal(scam.deferred, false);
    assert.equal(scam.archived, true);
    assert.equal(scam.blocked, false);
    assert.deepEqual(calls, [`label:${digits}:（可疑推銷）`, 'archive']);
  });

  it('lifts the label once a later review finds the chat ordinary', async () => {
    const calls = [];
    const client = fakeClient();
    client.info = null;
    const digits = '85261116666';
    const jid = `${digits}@c.us`;
    const chat = { id: { _serialized: jid }, async archive() { calls.push('archive'); } };
    const contact = { id: { _serialized: jid, user: digits }, isMyContact: false, number: digits };
    client.saveOrEditAddressbookContact = async (phone, name) => {
      calls.push(`label:${phone}:${name}`);
      Object.assign(contact, { isMyContact: true, name });
    };
    client.deleteAddressbookContact = async (phone) => {
      calls.push(`delete:${phone}`);
      Object.assign(contact, { isMyContact: false, name: undefined });
    };
    let verdict = { action: 'no_action', pitch: true, confidence: 0.6 };
    const deps = {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      botContactNames: createBotContactNames(),
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      maskClient: createStubJevlikeClient(),
      llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: (...args) => llmChatResponse(verdict)(...args) },
    };
    const send = (body, id) => handleWaMessage({
      type: 'chat', body, from: jid, id: { _serialized: id },
      async getChat() { return chat; },
      async getContact() { return contact; },
    }, deps);

    assert.equal((await send('你好，我哋診所有保健療程介紹', 'clinic-1')).labelled, true);
    verdict = { action: 'no_action', pitch: false, confidence: 0.9 };
    const ordinary = await send('你上星期喺診所登記嘅洗牙已經約咗星期三', 'clinic-2');
    assert.equal(ordinary.labelCleared, true);
    assert.equal(ordinary.archived, false);
    assert.equal(contact.name, undefined);
    assert.deepEqual(calls, [`label:${digits}:（可疑推銷）`, `delete:${digits}`]);

    assert.equal((await send('星期三見', 'clinic-3')).labelCleared, false);
    assert.deepEqual(calls, [`label:${digits}:（可疑推銷）`, `delete:${digits}`]);
  });

  it('does not queue a label lift for a sender the bot never labelled', async () => {
    const blockNamed = createBotContactNames();
    blockNamed.record(null, '85261117777', '封鎖·惡意域名');
    const client = fakeClient();
    client.info = null;
    client.deleteAddressbookContact = async () => assert.fail('must not delete');
    const digits = '85261117777';
    const jid = `${digits}@c.us`;
    const base = createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } });
    const pacer = Object.create(base);
    let queued = 0;
    pacer.exclusive = (fn) => { queued += 1; return base.exclusive(fn); };
    const out = await handleWaMessage({
      type: 'chat', body: '你上星期喺診所登記嘅洗牙已經約咗星期三', from: jid, id: { _serialized: 'fresh-1' },
      async getChat() { return { id: { _serialized: jid }, async archive() {} }; },
      async getContact() { return { id: { _serialized: jid, user: digits }, isMyContact: false, number: digits }; },
    }, {
      client,
      pacer,
      botContactNames: blockNamed,
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      maskClient: createStubJevlikeClient(),
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: llmChatResponse({ action: 'no_action', pitch: false, confidence: 0.9 }),
      },
    });
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.labelCleared, false);
    assert.equal(queued, 0);
  });

  const pitchLlm = () => ({
    enabled: true,
    apiUrl: 'http://llm.test/v1',
    fetchImpl: llmChatResponse({ action: 'no_action', pitch: true, confidence: 0.6 }),
  });
  const directMessage = (body, { chat, contact, id = 'pitch-msg' }) => ({
    type: 'chat', body, from: chat.id._serialized, id: { _serialized: id },
    async getChat() { return chat; },
    async getContact() { return contact; },
  });

  it('keeps a contact the user saved under the label name protected from a listed-URL block', async () => {
    const calls = [];
    const client = fakeClient();
    client.info = null;
    client.saveOrEditAddressbookContact = async () => { calls.push('rename'); };
    const digits = '85261114444';
    const chat = { id: { _serialized: `${digits}@c.us` }, async archive() { calls.push('archive'); }, async mute() {} };
    const contact = {
      id: { _serialized: `${digits}@c.us`, user: digits },
      number: digits,
      isMyContact: true,
      name: '（可疑推銷）',
      async block() { calls.push('block'); },
    };
    const out = await handleWaMessage(directMessage('交水費 https://wsd-gov.com', { chat, contact }), {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      botContactNames: createBotContactNames(),
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
      maskClient: createStubJevlikeClient(),
      llmReview: pitchLlm(),
    });
    assert.equal(out.heuristic.id, 'malicious_host');
    assert.equal(out.savedContact, true);
    assert.equal(out.deferred, true);
    assert.equal(out.blocked, false);
    assert.equal(out.archived, false);
    assert.deepEqual(calls, []);
  });

  it('does not write the label when the pitch is edited during rename pacing', async () => {
    const calls = [];
    const client = fakeClient();
    client.info = null;
    client.saveOrEditAddressbookContact = async (phone, name) => { calls.push(`label:${phone}:${name}`); };
    const digits = '85261115555';
    const chat = { id: { _serialized: `${digits}@c.us` }, async archive() { calls.push('archive'); } };
    const contact = { id: { _serialized: `${digits}@c.us`, user: digits }, number: digits, isMyContact: false };
    let current = true;
    const botContactNames = createBotContactNames();
    const out = await handleWaMessage(directMessage('王老師帶你炒股，每日穩賺5%，免費入群', { chat, contact }), {
      client,
      pacer: { exclusive: (fn) => fn(), pause: async () => { current = false; } },
      botContactNames,
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      maskClient: createStubJevlikeClient(),
      llmReview: pitchLlm(),
      isCurrent: () => current,
    });
    assert.equal(out.decision.action, 'label');
    assert.equal(out.labelled, false);
    assert.deepEqual(calls, []);
    assert.equal(botContactNames.wrote({ ...contact, name: '（可疑推銷）' }), false);
  });

  it('renames a bot-labelled sender to the block name on a guided block, so unblock can clean it up', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const client = fakeClient();
    const digits = '85261116666';
    const id = { _serialized: `${digits}@c.us`, user: digits };
    const contact = {
      id,
      number: digits,
      isMyContact: true,
      name: '（可疑推銷）',
      async block() { calls.push('block'); },
    };
    const chat = {
      id,
      async archive() { calls.push('archive'); },
      async mute() {},
      async getContact() { return contact; },
    };
    client.getChatById = async () => chat;
    client.saveOrEditAddressbookContact = async (_phone, name) => {
      calls.push(`rename:${name}`);
      contact.name = name;
    };
    const botContactNames = createBotContactNames();
    botContactNames.record(contact, digits, '（可疑推銷）');
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const deps = {
      client,
      reviewQueue: queue,
      botContactNames,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
      maskClient: createStubJevlikeClient(),
      llmReview: pitchLlm(),
    };
    attachHandlers(client, deps);
    const out = await handleWaMessage({
      ...directMessage('交水費 https://wsd-gov.com', { chat, contact, id: 'guided-pitch' }),
      forward: async () => {},
    }, deps);
    assert.equal(out.savedContact, false);
    assert.equal(out.deferred, true);
    const pollId = `sent-${client.sent.length}`;
    assert.equal(queue.get(pollId).savedContact, false);
    await client.handlers.vote_update({
      selectedOptions: [{ name: '封鎖並封存' }],
      parentMessage: { id: { _serialized: pollId } },
    });
    assert.deepEqual(calls.slice(0, 2), ['block', `rename:${contactNameForBlock()}`]);
    const logged = JSON.parse(fs.readFileSync(deps.env.BLOCK_LOG_PATH, 'utf8').trim().split('\n').at(-1));
    assert.equal(logged.savedContact, false);
    assert.equal(logged.renamed, true);
  });
});

describe('own messages in the context review through the client handlers', () => {
  it('shows the user\'s question, edited in place, before the reply it asked for', async () => {
    const client = fakeClient();
    const chatId = '85261117777@c.us';
    const chat = { isGroup: false, id: { _serialized: chatId }, async archive() { throw new Error('must not archive'); } };
    const contact = {
      isMyContact: false,
      isMe: false,
      pushname: 'Seller',
      id: { _serialized: chatId, user: '85261117777' },
      number: '85261117777',
    };
    const reviewed = [];
    const recentContext = createRecentContext();
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env: { CONTEXT_LLM_ENABLED: '1' },
      recentContext,
      maskClient: createStubJevlikeClient(0.05),
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        async fetchImpl(url, init) {
          reviewed.push(JSON.parse(init.body).messages.at(-1).content);
          return llmChatResponse({ action: 'no_action', confidence: 0.9 })(url, init);
        },
      },
      llmCooldownStore: createLlmReviewCooldownStore(),
    });
    const own = (body) => ({
      fromMe: true,
      body,
      type: 'chat',
      to: chatId,
      id: { _serialized: 'own-1' },
      async getChat() { return chat; },
    });
    await client.handlers.message_create(own('仲有冇貨？'));
    await client.handlers.message_edit(own('仲有冇貨？點俾錢？'), '仲有冇貨？點俾錢？', '仲有冇貨？');
    await client.handlers.message_create({
      ...own('self note'),
      id: { _serialized: 'own-self' },
      async getChat() { return { isGroup: false, id: { _serialized: 'me@c.us' } }; },
    });
    await client.handlers.message({
      fromMe: false,
      body: '有，$800，轉數快到 91234567',
      type: 'chat',
      from: chatId,
      id: { _serialized: 'in-1' },
      async getChat() { return chat; },
      async getContact() { return contact; },
    });

    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0], '[1] user: 仲有冇貨？點俾錢？\n[2] 有，$800，轉數快到 XXX');
    assert.deepEqual(recentContext.recent('me@c.us'), []);
  });
});

describe('chats the user restored from the archive', () => {
  const chatId = '85261118888@c.us';

  function restoredChatFixture(t, { cooldownMs = '600000' } = {}) {
    const dir = tempDir();
    const previousLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    t.after(() => {
      if (previousLog === undefined) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = previousLog;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const env = { LLM_REVIEW_COOLDOWN_MS: cooldownMs, BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH };
    const store = createLlmReviewCooldownStore({ filePath: path.join(dir, 'cooldown.json'), env });
    const userRestoredChats = createUserRestoredChats({ filePath: path.join(dir, 'restored.json') });
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const events = [];
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => { events.push('rename'); };
    const chat = {
      isGroup: false,
      id: { _serialized: chatId },
      async archive() { events.push('archive'); },
      async mute() {},
    };
    const contact = {
      isMe: false,
      isMyContact: false,
      id: { _serialized: chatId, user: '85261118888' },
      number: '85261118888',
      async block() { events.push('block'); },
    };
    client.getChatById = async () => chat;
    client.getContactById = async () => contact;
    let n = 0;
    const send = (body) => client.handlers.message({
      fromMe: false,
      body,
      type: 'chat',
      from: chatId,
      id: { _serialized: `restored-${++n}` },
      getChat: async () => chat,
      getContact: async () => contact,
      async forward() { events.push('forward'); },
    });
    attachHandlers(client, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      env,
      maskClient: createStubJevlikeClient('benign'),
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: llmChatResponse({ action: 'archive', label: 'scam', confidence: 0.95, reason: 'test' }),
      },
      llmCooldownStore: store,
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      botContactNames: createBotContactNames(),
      userRestoredChats,
    });
    const expireCooldown = () => store.set(chatId, store.get(chatId) - Number(cooldownMs) - 1);
    return { chat, client, events, send, store, userRestoredChats, expireCooldown, queue };
  }

  it('does not archive again after the user un-archives a chat the bot archived', async (t) => {
    const { chat, client, events, send, userRestoredChats, expireCooldown, queue } = restoredChatFixture(t);

    await send('你好，請把驗證碼發給我');
    assert.deepEqual(events, ['archive'], 'the first confident verdict archives automatically');

    client.handlers.chat_archived(chat, false, true);
    assert.equal(userRestoredChats.has(chatId), true, 'the un-archive is recorded');

    expireCooldown();
    await send('快啲回覆，驗證碼呢？');
    assert.deepEqual(events.filter((e) => e === 'archive'), ['archive'], 'the chat stays where the user put it');
    assert.ok(queue.findOpenByMessageId('restored-2'), 'the verdict goes to the operator as a review card');
  });

  it('remembers the un-archive after a restart', (t) => {
    const { chat, client, userRestoredChats } = restoredChatFixture(t);
    client.handlers.chat_archived(chat, false, true);
    assert.equal(createUserRestoredChats({ filePath: userRestoredChats.path }).has(chatId), true);
  });

  it('ignores archiving, groups, and state reloads that are not an un-archive', (t) => {
    const { chat, client, userRestoredChats } = restoredChatFixture(t);
    client.handlers.chat_archived(chat, true, false);
    client.handlers.chat_archived(chat, false, false);
    client.handlers.chat_archived({ ...chat, isGroup: true, id: { _serialized: 'g@g.us' } }, false, true);
    assert.equal(userRestoredChats.has(chatId), false);
    assert.equal(userRestoredChats.has('g@g.us'), false);
  });

  it('still blocks a curated malicious host in a restored chat', async (t) => {
    const { chat, client, events, send } = restoredChatFixture(t);
    client.handlers.chat_archived(chat, false, true);
    await send('登入 https://malicious-block-test.invalid/login');
    assert.ok(events.includes('block'), 'the maintained malicious-host list still blocks');
    assert.ok(events.includes('archive'));
  });
});

describe('saved status from the phone-number identity through the client handler', () => {
  const lid = '201234567890123@lid';
  const phone = '85291234567@c.us';

  async function listedUrlFromLid({
    lidContact = {}, mappings = [{ lid, pn: phone }], phoneContact, lookupError, contactError, reviewQueue = null, editOnRefresh = false,
  } = {}) {
    const events = [];
    let lookups = 0;
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => {};
    client.getContactLidAndPhone = async (ids) => {
      assert.deepEqual(ids, [lid]);
      return mappings;
    };
    client.getContactById = async (id) => {
      assert.equal(id, phone);
      if (lookupError) throw new Error('lookup down');
      lookups += 1;
      return {
        isMe: false,
        name: '',
        id: { _serialized: phone, user: '85291234567' },
        async block() { events.push('block'); },
        ...phoneContact,
      };
    };
    const chat = {
      isGroup: false,
      id: { _serialized: lid },
      async archive() { events.push('archive'); },
      async mute() { events.push('mute'); },
    };
    const msg = {
      fromMe: false,
      body: '登入 https://malicious-block-test.invalid/login',
      type: 'chat',
      from: lid,
      id: { _serialized: `msg-${events.length}-${Math.random()}` },
      async getChat() { return chat; },
      async forward() { events.push('forward'); },
      async getContact() {
        if (contactError) throw new Error('contact read failed');
        return {
          isMe: false,
          isMyContact: false,
          pushname: 'Ada',
          id: { _serialized: phone, user: '85291234567' },
          async block() { events.push('block'); },
          ...lidContact,
        };
      },
    };
    const out = await handleWaMessage(msg, {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient(0.05),
      llmReview: { enabled: false },
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'auto' },
        filePath: path.join(tempDir(), 'mode.json'),
      }),
      reviewQueue,
      isCurrent: () => !(editOnRefresh && lookups > 1),
    });
    return { out, events };
  }

  it('does not block a contact saved by phone number whose LID record says unsaved', async () => {
    const { out, events } = await listedUrlFromLid({ phoneContact: { isMyContact: true, name: 'Ada Chan' } });
    assert.equal(out.savedContact, true);
    assert.equal(out.deferred, true);
    assert.deepEqual(events, []);
  });

  it('resolves an unread LID sender to its phone-number contact for explicit actions', async () => {
    const { loadSenderContact } = require('./sender-contact');
    const client = fakeClient();
    client.getContactLidAndPhone = async () => [{ lid, pn: phone }];
    client.getContactById = async (id) => ({ isMyContact: false, id: { _serialized: id } });
    const loaded = await loadSenderContact(client, { senderId: lid, contact: null });
    assert.equal(loaded && loaded.id._serialized, phone);
  });

  it('keeps a contact saved on its LID record protected', async () => {
    const { out, events } = await listedUrlFromLid({
      lidContact: { isMyContact: true, name: 'Ada Chan' },
      phoneContact: { isMyContact: false },
    });
    assert.equal(out.savedContact, true);
    assert.deepEqual(events, []);
  });

  for (const scenario of [
    { name: 'no phone number for the LID', mappings: [] },
    { name: 'the phone-number contact lookup fails', lookupError: true },
    { name: 'WhatsApp gives no saved flag', phoneContact: { isMyContact: undefined } },
    { name: 'the sender contact cannot be read', contactError: true, phoneContact: { isMyContact: false } },
  ]) {
    it(`only alerts when saved status is unknown: ${scenario.name}`, async () => {
      const { out, events } = await listedUrlFromLid(scenario);
      assert.equal(out.savedContact, null);
      assert.equal(out.decision.action, 'archive');
      assert.equal(out.deferred, true);
      assert.deepEqual(events, []);
    });
  }

  it('still blocks and archives a LID sender unsaved by phone number', async () => {
    const { out, events } = await listedUrlFromLid({ phoneContact: { isMyContact: false } });
    assert.equal(out.savedContact, false);
    assert.equal(out.decision.action, 'block');
    assert.deepEqual(events, ['block', 'mute', 'archive']);
  });

  it('does not block or archive when the message is edited while the phone contact is reread', async () => {
    const { out, events } = await listedUrlFromLid({ phoneContact: { isMyContact: false }, editOnRefresh: true });
    assert.equal(out.decision.action, 'block');
    assert.deepEqual(events, []);
  });

  it('queues an unknown-status review without a block name', async () => {
    const queue = createReviewQueue({ filePath: path.join(tempDir(), 'q.json') });
    const { out, events } = await listedUrlFromLid({ mappings: [], reviewQueue: queue });
    assert.equal(out.deferred, true);
    assert.deepEqual(events, ['forward']);
    const [item] = Object.values(JSON.parse(fs.readFileSync(queue.path, 'utf8')).items);
    assert.equal(item.savedContact, null);
    assert.equal(item.contactName, null);
  });

  it('does not rename a contact saved by phone number on a block vote from its LID chat', async () => {
    const dir = tempDir();
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      pollId: 'review', chatId: lid, digits: '85291234567',
      contactName: '封鎖·惡意域名', savedContact: false,
    });
    const events = [];
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => { events.push('rename'); };
    client.getContactLidAndPhone = async () => [{ lid, pn: phone }];
    client.getContactById = async () => ({
      isMyContact: true, name: 'Ada Chan', id: { _serialized: phone },
      async block() { events.push('block'); },
    });
    client.getChatById = async () => ({
      async getContact() {
        return { isMyContact: false, name: '', id: { _serialized: lid }, async block() { events.push('block'); } };
      },
      async archive() { events.push('archive'); },
      async mute() { events.push('mute'); },
    });
    const previousLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    try {
      attachHandlers(client, {
        operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: queue,
        pacer: { exclusive: (fn) => fn(), async pause() {} },
      });
      await client.handlers.vote_update({
        selectedOptions: [{ name: '封鎖並封存' }],
        parentMessage: { id: { _serialized: 'review' } },
      });
    } finally {
      if (previousLog === undefined) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = previousLog;
    }
    assert.equal(events.includes('rename'), false);
    assert.equal(events.includes('block'), true);
    const [poll] = queue.findOpenUnblock();
    assert.equal(poll.savedContact, true);
  });

  it('prefers validated phone JID over leaked LID digits in contact.number', async () => {
    const { resolveRealNumber } = require('./lid');
    const out = await resolveRealNumber(null, '85291234567@c.us', {
      id: { _serialized: '85291234567@c.us' },
      number: '999999999999999',
    });
    assert.equal(out.digits, '85291234567');
    assert.equal(out.unresolvedLid, false);
  });

  it('recognizes bot-written pitch labels on @lid senders and clears them on later benign review', async (t) => {
    const nodeOs = require('node:os');
    const { handleWaMessage } = require('../whatsapp-bot');
    const { createBotContactNames } = require('./bot-contact-names');
    const { loadSenderContact } = require('./sender-contact');
    const { clearsPitchLabel } = require('./context-llm');

    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'lid-pitch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const lidId = '555444333@lid';
    const pnId = '85261239999@c.us';
    const botNames = createBotContactNames({ filePath: path.join(dir, 'bot-names.json') });
    const phoneContact = { isMyContact: true, name: '（可疑推銷）', id: { _serialized: pnId }, number: '85261239999' };
    botNames.record(phoneContact, '85261239999', '（可疑推銷）', { extraIds: [lidId] });

    const client = fakeClient();
    const deleted = [];
    client.getContactLidAndPhone = async () => [{ lid: lidId, pn: pnId }];
    client.getContactById = async (id) => (id === pnId ? phoneContact : null);
    client.deleteAddressbookContact = async (digits) => deleted.push(digits);

    const lidContact = { isMyContact: true, name: '（可疑推銷）', id: { _serialized: lidId } };
    const loaded = await loadSenderContact(client, {
      senderId: lidId,
      contact: lidContact,
      botContactNames: botNames,
    });
    assert.equal(loaded.id._serialized, pnId);
    assert.equal(clearsPitchLabel({ ok: true, action: 'no_action', pitch: false, confidence: 0.9 }, { savedContact: false, env: {} }), true);

    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    await handleWaMessage(
      {
        fromMe: false,
        type: 'chat',
        body: '原來係你呀，唔好意思認錯人',
        from: lidId,
        id: { _serialized: 'm-pitch-clear' },
        async getChat() { return { id: { _serialized: lidId }, isGroup: false }; },
        async getContact() { return lidContact; },
      },
      {
        client,
        env: { CONTEXT_LLM_ENABLED: 'true', LLM_REVIEW_ENABLED: 'true', LLM_REVIEW_COOLDOWN_MS: '0' },
        operator: createOperatorState({ env: { OPERATOR_MODE: 'automatic' }, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: queue,
        botContactNames: botNames,
        pacer: { exclusive: (fn) => fn(), async pause() {} },
        recentContext: createRecentContext(),
        threadContext: createThreadContext({ turns: 4 }),
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'no_action', pitch: false, confidence: 0.92, reason: 'mistake' }),
        },
        llmCooldownStore: createLlmReviewCooldownStore(),
      },
    );
    assert.deepEqual(deleted, ['85261239999']);
    assert.equal(botNames.wrote({ id: { _serialized: lidId }, name: '（可疑推銷）' }), false);
  });

  it('allows explicit guided block without renaming when @lid contact refresh returns null', async (t) => {
    const nodeOs = require('node:os');
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'null-refresh-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const lid = '999888777@lid';
    queue.add({
      kind: 'review',
      pollId: 'review-null',
      chatId: lid,
      digits: null,
      savedContact: false,
      senderName: 'Unknown',
      reason: 'model',
    });
    const events = [];
    const client = fakeClient();
    client.saveOrEditAddressbookContact = async () => { events.push('rename'); };
    client.getContactLidAndPhone = async () => [{ lid, pn: null }];
    client.getChatById = async () => ({
      async getContact() {
        return { isMyContact: false, name: '', id: { _serialized: lid }, async block() { events.push('block'); } };
      },
      async archive() { events.push('archive'); },
      async mute() { events.push('mute'); },
    });
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: { exclusive: (fn) => fn(), async pause() {} },
    });
    await client.handlers.vote_update({
      selectedOptions: [{ name: '封鎖並封存' }],
      parentMessage: { id: { _serialized: 'review-null' } },
    });
    assert.equal(events.includes('rename'), false);
    assert.equal(events.includes('block'), true);
    assert.equal(events.includes('archive'), true);
  });

  it('skips recording @lid self-chat messages in recentContext', async (t) => {
    const nodeOs = require('node:os');
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'self-lid-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const client = fakeClient();
    client.getContactLidAndPhone = async () => [{ lid: 'my@lid', pn: 'me@c.us' }];
    const recentContext = createRecentContext();
    attachHandlers(client, {
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
      recentContext,
    });
    await client.handlers.message_create({
      fromMe: true,
      type: 'chat',
      body: 'self note on @lid',
      id: { _serialized: 'self-lid-1' },
      async getChat() { return { id: { _serialized: 'my@lid' }, isGroup: false }; },
      async getContact() { return { isMe: true }; },
    });
    assert.deepEqual(recentContext.recent('my@lid'), []);

    await client.handlers.message_create({
      fromMe: true,
      type: 'chat',
      body: 'hi friend',
      id: { _serialized: 'peer-1' },
      async getChat() { return { id: { _serialized: '85261112222@c.us' }, isGroup: false }; },
      async getContact() { return { isMe: false }; },
    });
    assert.equal(recentContext.recent('85261112222@c.us').length, 1);
  });

  it('suppresses action receipt notice when an edit makes blockAndRename stale during pacing', async (t) => {
    const nodeOs = require('node:os');
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'stale-notice-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const client = fakeClient();
    const chatId = '85265554444@c.us';
    const messageId = 'msg-stale-block';
    const contact = {
      isMyContact: false,
      id: { _serialized: chatId, user: '85265554444' },
      number: '85265554444',
      async block() {},
    };
    const msg = {
      type: 'chat',
      body: '登入 https://malicious-block-test.invalid/login',
      from: chatId,
      id: { _serialized: messageId },
      async getChat() { return { id: { _serialized: chatId }, async archive() {}, async mute() {} }; },
      async getContact() { return contact; },
    };
    client.getContactById = async () => contact;

    let editPromise = null;
    attachHandlers(client, {
      env: { OPERATOR_MODE: 'automatic', CONTEXT_LLM_ENABLED: 'false', LLM_REVIEW_ENABLED: 'false' },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'automatic' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: {
        exclusive: (fn) => fn(),
        async pause() {
          if (!editPromise) {
            editPromise = client.handlers.message_edit(
              { ...msg, body: '睇錯咗，無事' },
              '睇錯咗，無事',
              msg.body,
            );
          }
        },
      },
      recentContext: null,
      threadContext: createThreadContext({ turns: 4 }),
    });

    await client.handlers.message(msg);
    if (editPromise) await editPromise;
    const receipts = client.sent.filter((item) => typeof item === 'string' && /已自動/.test(item));
    assert.deepEqual(receipts, []);
  });

  it('does not record LLM cooldown when guided delivery fails without a pollId', async (t) => {
    const nodeOs = require('node:os');
    const { handleWaMessage } = require('../whatsapp-bot');
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'no-wid-cd-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const client = fakeClient();
    client.info = {};
    const store = createLlmReviewCooldownStore({ filePath: path.join(dir, 'cd.json') });
    const chatId = '85267778888@c.us';
    await handleWaMessage(
      {
        type: 'chat',
        body: '高回報投資保證賺錢，請提供驗證碼',
        from: chatId,
        id: { _serialized: 'msg-no-wid' },
        async getChat() { return { id: { _serialized: chatId }, async archive() {} }; },
        async getContact() { return { isMyContact: false, id: { _serialized: chatId }, number: '85267778888' }; },
      },
      {
        client,
        env: { CONTEXT_LLM_ENABLED: 'true', LLM_REVIEW_ENABLED: 'true', LLM_REVIEW_COOLDOWN_MS: '60000' },
        operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: createReviewQueue({ filePath: path.join(dir, 'q.json') }),
        pacer: { exclusive: (fn) => fn(), async pause() {} },
        recentContext: createRecentContext(),
        threadContext: createThreadContext({ turns: 4 }),
        maskClient: createStubJevlikeClient('benign'),
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'archive', strong: true, confidence: 0.95, reason: 'scam' }),
        },
        llmCooldownStore: store,
      },
    );
    assert.equal(isChatLlmCooldownActive(chatId, { LLM_REVIEW_COOLDOWN_MS: '60000' }, { store }), false);
  });

  it('replies with ambiguous keep-blocked list instead of guessing between multiple open polls', async (t) => {
    const nodeOs = require('node:os');
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'ambig-keep-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({ kind: 'unblock', pollId: 'ub-1', chatId: '85291111111@c.us', digits: '85291111111', contactName: '封鎖·A' });
    queue.add({ kind: 'unblock', pollId: 'ub-2', chatId: '85292222222@c.us', digits: '85292222222', contactName: '封鎖·B' });
    const client = fakeClient();
    attachHandlers(client, {
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: { exclusive: (fn) => fn(), async pause() {} },
    });
    await client.handlers.message_create({
      fromMe: true,
      body: '保持',
      hasQuotedMsg: false,
      async getChat() { return { id: { _serialized: 'me@c.us' } }; },
      async getContact() { return { isMe: true }; },
    });
    assert.equal(queue.findOpenUnblock().length, 2);
    assert.match(String(client.sent.at(-1)), /有多個待決定/);
  });

  it('notifies operator even if queue.release throws while recovering from failed unblock', async (t) => {
    const nodeOs = require('node:os');
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'release-err-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    queue.add({
      kind: 'unblock',
      pollId: 'ub-release-err',
      chatId: '85294445555@c.us',
      digits: '85294445555',
      contactName: '封鎖·Err',
      blockContactName: '封鎖·Err',
    });
    queue.release = () => {
      throw new Error('release disk error');
    };
    const client = fakeClient();
    client.getChatById = async () => {
      throw new Error('wa lookup down');
    };
    attachHandlers(client, {
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: { exclusive: (fn) => fn(), async pause() {} },
    });
    await client.handlers.vote_update({
      selectedOptions: [{ name: '解除封鎖' }],
      parentMessage: { id: { _serialized: 'ub-release-err' } },
    });
    assert.ok(client.sent.some((m) => typeof m === 'string' && m.includes('做唔到：wa lookup down')));
  });

  it('keeps a user-saved LID contact protected when phone contact still holds a bot label under another name', async (t) => {
    const nodeOs = require('node:os');
    const { handleWaMessage } = require('../whatsapp-bot');
    const { createBotContactNames } = require('./bot-contact-names');
    const { loadSenderContact } = require('./sender-contact');

    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'lid-saved-diff-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const lidId = '11223344@lid';
    const pnId = '85269990000@c.us';
    const botNames = createBotContactNames({ filePath: path.join(dir, 'bot-names.json') });
    const phoneContact = { isMyContact: true, name: '（可疑推銷）', id: { _serialized: pnId }, number: '85269990000' };
    botNames.record(phoneContact, '85269990000', '（可疑推銷）');

    const lidContact = { isMyContact: true, name: 'Ada Chan', id: { _serialized: lidId } };
    const client = fakeClient();
    client.getContactLidAndPhone = async () => [{ lid: lidId, pn: pnId }];
    client.getContactById = async (id) => (id === pnId ? phoneContact : null);

    const loaded = await loadSenderContact(client, {
      senderId: lidId,
      contact: lidContact,
      botContactNames: botNames,
    });
    assert.equal(loaded, lidContact);

    let blocked = false;
    const queue = createReviewQueue({ filePath: path.join(dir, 'q.json') });
    const out = await handleWaMessage(
      {
        fromMe: false,
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/login',
        from: lidId,
        id: { _serialized: 'm-ada-malicious' },
        async getChat() { return { id: { _serialized: lidId }, isGroup: false, async archive() {} }; },
        async getContact() { return { ...lidContact, async block() { blocked = true; } }; },
        async forward() {},
      },
      {
        client,
        env: { CONTEXT_LLM_ENABLED: 'false', LLM_REVIEW_ENABLED: 'false' },
        operator: createOperatorState({ env: { OPERATOR_MODE: 'automatic' }, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: queue,
        botContactNames: botNames,
        pacer: { exclusive: (fn) => fn(), async pause() {} },
        recentContext: null,
        threadContext: createThreadContext({ turns: 4 }),
      },
    );
    assert.equal(blocked, false);
    assert.equal(out.deferred, true);
  });
});
