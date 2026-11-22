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
      { name: 'anti-scam authority impersonation without explicit ask', body: `反詐騙協調中心通知：你嘅戶口涉及詐騙案，詳情見 ${url}`, action: 'block' },
      { name: 'anti-scam website notice still blocks unsaved sender', body: `反詐騙協調中心網站 ${url} 幫你追回款項`, action: 'block' },
      { name: 'anti-scam noun prefix still blocks unsaved sender', body: `反詐騙網站 ${url} 幫你追回款項`, action: 'block' },
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
          assert.deepEqual(calls, saved ? ['archive'] : ['block', 'mute', 'archive']);
        } else if (maskFails) {
          assert.equal(out.llmTrigger.skipped, 'mask_failed');
          assert.deepEqual(calls, ['mask']);
        } else {
          assert.equal(out.llmReview.ok, true);
          assert.deepEqual(calls, verdict === 'block' ? ['mask', 'AI', 'archive'] : ['mask', 'AI']);
          assert.ok(sentToModel.includes(`XXX${body.slice(2)}`));
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
      isMyContact: true,
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
      llmReview: { enabled: false },
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
      llmReview: { enabled: false },
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
        llmReview: { enabled: false },
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
        llmReview: { enabled: false },
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
      OPERATOR_MODE: process.env.OPERATOR_MODE,
      OPERATOR_MODE_PATH: process.env.OPERATOR_MODE_PATH,
      REVIEW_QUEUE_PATH: process.env.REVIEW_QUEUE_PATH,
    };
    const original = Client.prototype.initialize;
    Client.prototype.initialize = async function stubInitialize() {
      return undefined;
    };
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
