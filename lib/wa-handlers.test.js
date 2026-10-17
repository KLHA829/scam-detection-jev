'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { attachHandlers, handleWaMessage, createWhatsAppClient, puppeteerArgs } = require('../whatsapp-bot');
const { createOperatorState } = require('./operator-mode');
const { createReviewQueue } = require('./review-queue');
const { createActionPacer } = require('./action-pacer');
const { createThreadContext } = require('./thread-context');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { scamLlmFetch } = require('./test-llm');

const rubric = loadRubric();

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
      rubric,
      cache: null,
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
      rubric,
      cache: null,
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

    const failed = await handleWaMessage(
      {
        ...msg,
        id: { _serialized: 'msg-archive-fail' },
        async getChat() {
          return {
            ...chat,
            async archive() {
              throw new Error('archive down');
            },
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
        rubric,
        cache: null,
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
        rubric,
        cache: null,
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
      rubric,
      cache: null,
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
        rubric,
        cache: null,
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
      rubric,
      cache: null,
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
});

describe('createWhatsAppClient', () => {
  it('builds a client without starting the browser', () => {
    const client = createWhatsAppClient();
    assert.equal(typeof client.initialize, 'function');
    assert.equal(typeof client.on, 'function');
  });

  it('turns the sandbox off only for the root user', () => {
    assert.deepEqual(puppeteerArgs(0), [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]);
    assert.deepEqual(puppeteerArgs(1000), ['--disable-dev-shm-usage']);
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
        rubric,
        cache: null,
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
      rubric,
      cache: null,
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
        rubric,
        cache: null,
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
