'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
require('../../scripts/block-log-test-setup');

const { createWhatsAppTransport, isWaTransport } = require('./index');
const {
  createWhatsmeowTransport,
  isLoopbackHostname,
  validateBridgeBaseUrl,
  parseSseBlock,
} = require('./whatsmeow');
const { attachHandlers } = require('../../whatsapp-bot');
const { createOperatorState } = require('../operator-mode');
const { createReviewQueue } = require('../review-queue');
const { createActionPacer } = require('../action-pacer');
const { createThreadContext } = require('../thread-context');
const { createRecentContext } = require('../context-llm');
const { createBotContactNames } = require('../bot-contact-names');
const { createStubJevlikeClient } = require('../../stub-jevlike');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-whatsmeow-'));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function startMockBridge({
  token = 'test-bridge-token',
  selfWid = '85299990000@c.us',
  selfLid = '99990000@lid',
  contacts = new Map(),
  lidMap = new Map(),
} = {}) {
  const calls = [];
  const sseClients = new Set();
  const receivedLastEventIds = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          state: 'ready',
          connected: true,
          loggedIn: true,
          contactsSynced: true,
          selfWid,
          selfLid,
        }),
      );
      return;
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      receivedLastEventIds.push(req.headers['last-event-id'] || '');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/contact') {
      const id = url.searchParams.get('id') || '';
      const entry = contacts.get(id);
      if (entry === 'ERROR_503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not ready' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          entry || {
            id,
            number: id.endsWith('@c.us') ? id.split('@')[0] : '',
            name: '',
            pushname: '',
            isMyContact: null,
            isMe: false,
            contactsSynced: false,
          },
        ),
      );
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    if (req.method === 'POST' && url.pathname === '/v1/lid/resolve') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const mappings = [];
      for (const id of ids) {
        if (lidMap.has(id)) mappings.push({ lid: id, pn: lidMap.get(id) });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mappings }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/send/text') {
      seq += 1;
      const id = `wm-text-${seq}`;
      calls.push({ op: 'sendText', ...body, id });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/send/poll') {
      seq += 1;
      const id = `wm-poll-${seq}`;
      calls.push({ op: 'sendPoll', ...body, id });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/message/forward') {
      seq += 1;
      const id = `wm-fwd-${seq}`;
      calls.push({ op: 'forward', ...body, id });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/archive') {
      calls.push({ op: body.archived ? 'archiveChat' : 'unarchiveChat', ...body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/mute') {
      calls.push({ op: body.muted ? 'muteChat' : 'unmuteChat', ...body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/contact/block') {
      calls.push({ op: body.blocked ? 'blockContact' : 'unblockContact', ...body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/contact/label') {
      calls.push({ op: body.name ? 'saveContactName' : 'deleteContactName', ...body });
      const jid = `${body.phone}@c.us`;
      const prev = contacts.get(jid) || { id: jid, number: body.phone, isMe: false };
      contacts.set(jid, {
        ...prev,
        name: body.name || '',
        isMyContact: Boolean(body.name),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    token,
    calls,
    contacts,
    lidMap,
    sseClients,
    receivedLastEventIds,
    pushEvent(id, type, data) {
      const payload = JSON.stringify({ id, type, data });
      const frame = (id ? `id: ${id}\n` : '') + `event: ${type}\ndata: ${payload}\n\n`;
      for (const client of sseClients) {
        client.write(frame);
      }
    },
    dropAllSse() {
      for (const client of [...sseClients]) {
        client.end();
        sseClients.delete(client);
      }
    },
    async close() {
      for (const client of [...sseClients]) {
        client.destroy();
      }
      sseClients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('whatsmeow WaTransport config and security checks', () => {
  it('enforces loopback URLs and required WA_BRIDGE_TOKEN', () => {
    assert.equal(isLoopbackHostname('127.0.0.1'), true);
    assert.equal(isLoopbackHostname('localhost'), true);
    assert.equal(isLoopbackHostname('[::1]'), true);
    assert.equal(isLoopbackHostname('0.0.0.0'), false);
    assert.equal(isLoopbackHostname('127.999.0.1'), false);
    assert.equal(isLoopbackHostname('example.com'), false);

    assert.equal(validateBridgeBaseUrl('http://127.0.0.1:8767/extra'), 'http://127.0.0.1:8767');
    assert.throws(() => validateBridgeBaseUrl('http://192.168.1.10:8767'), /loopback/);
    assert.throws(() => validateBridgeBaseUrl('ftp://127.0.0.1:8767'), /http or https/);
    assert.throws(
      () => createWhatsmeowTransport({ autoStart: true, baseUrl: 'https://127.0.0.1:8767' }),
      /only supports http:\/\//,
    );

    assert.throws(
      () => createWhatsAppTransport({ env: { WA_TRANSPORT: 'whatsmeow' } }),
      /WA_BRIDGE_TOKEN is required/,
    );
    const transport = createWhatsAppTransport({
      env: { WA_TRANSPORT: 'whatsmeow', WA_BRIDGE_TOKEN: 'tok-1' },
    });
    assert.equal(isWaTransport(transport), true);
    assert.equal(transport.name, 'whatsmeow');
  });

  it('parses multi-line SSE blocks and ignores keepalive comments', () => {
    assert.equal(parseSseBlock(': ping'), null);
    const parsed = parseSseBlock('id: ep1:7\nevent: qr\ndata: {"type":"qr","data":{"qr":"abc"}}');
    assert.deepEqual(parsed, {
      id: 'ep1:7',
      event: 'qr',
      payload: { type: 'qr', data: { qr: 'abc' } },
    });
  });
});

describe('whatsmeow WaTransport HTTP + SSE integration with bot handlers', () => {
  it('reconnects SSE with Last-Event-ID and streams qr, ready, block, and unblock flows', async (t) => {
    const dir = tempDir();
    const prevBlockLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    const senderJid = '85261230001@c.us';
    const bridge = await startMockBridge({
      contacts: new Map([
        [
          senderJid,
          {
            id: senderJid,
            number: '85261230001',
            name: '',
            pushname: 'Scammer',
            isMyContact: false,
            isMe: false,
            contactsSynced: true,
          },
        ],
      ]),
    });
    const transport = createWhatsmeowTransport({
      baseUrl: bridge.baseUrl,
      token: bridge.token,
      cursorPath: path.join(dir, 'cursor.json'),
      reconnectBaseMs: 25,
      reconnectMaxMs: 50,
    });
    t.after(async () => {
      await transport.destroy();
      await bridge.close();
      if (prevBlockLog === undefined) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = prevBlockLog;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const seenQr = [];
    transport.on('qr', (code) => seenQr.push(code));
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    const botContactNames = createBotContactNames({ filePath: path.join(dir, 'bot-names.json') });
    attachHandlers(transport, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      botContactNames,
    });

    await transport.initialize();
    await waitFor(() => bridge.sseClients.size === 1);
    assert.equal(transport.getSelfWid(), '85299990000@c.us');
    assert.equal(transport.getSelfLid(), '99990000@lid');

    bridge.pushEvent('ep1:1', 'qr', { qr: 'live-qr-payload' });
    await waitFor(() => seenQr.length === 1);
    assert.equal(seenQr[0], 'live-qr-payload');

    bridge.dropAllSse();
    await waitFor(() => bridge.receivedLastEventIds.length >= 2);
    assert.equal(bridge.receivedLastEventIds[1], 'ep1:1');

    bridge.pushEvent('ep1:2', 'message', {
      id: 'wm-mal-1',
      chatId: senderJid,
      from: senderJid,
      author: senderJid,
      fromMe: false,
      type: 'chat',
      body: '請登入 https://hutong.biz/login',
      notifyName: 'Scammer',
    });

    await waitFor(() => bridge.calls.some((c) => c.op === 'sendPoll'));
    assert.deepEqual(
      bridge.calls.map((c) => c.op),
      ['blockContact', 'saveContactName', 'muteChat', 'archiveChat', 'sendText', 'sendPoll'],
    );
    const unblockPoll = bridge.calls.find((c) => c.op === 'sendPoll');

    bridge.pushEvent('ep1:3', 'vote_update', {
      parentMessageId: unblockPoll.id,
      selectedOptions: ['解除封鎖'],
    });
    await waitFor(() => bridge.calls.length >= 10);
    assert.deepEqual(
      bridge.calls.slice(6).map((c) => c.op),
      ['unblockContact', 'deleteContactName', 'unmuteChat', 'sendText'],
    );
  });

  it('fails closed on cold-start unknown contact status, protects @lid saved contacts, and handles edits & self-chat', async (t) => {
    const dir = tempDir();
    const coldJid = '85261230002@c.us';
    const lidSaved = '555000111@lid';
    const pnSaved = '85261230003@c.us';
    const editableJid = '85261230004@c.us';

    const bridge = await startMockBridge({
      contacts: new Map([
        [coldJid, { id: coldJid, number: '85261230002', name: '', pushname: 'Cold', isMyContact: null, isMe: false, contactsSynced: false }],
        [lidSaved, { id: lidSaved, name: '', pushname: 'Mum', isMyContact: false, isMe: false, contactsSynced: true }],
        [pnSaved, { id: pnSaved, number: '85261230003', name: 'Mum', isMyContact: true, isMe: false, contactsSynced: true }],
        [editableJid, { id: editableJid, number: '85261230004', name: '', isMyContact: false, isMe: false, contactsSynced: true }],
      ]),
      lidMap: new Map([[lidSaved, pnSaved]]),
    });
    const transport = createWhatsmeowTransport({
      baseUrl: bridge.baseUrl,
      token: bridge.token,
      cursorPath: path.join(dir, 'cursor.json'),
      reconnectBaseMs: 25,
      reconnectMaxMs: 50,
    });
    t.after(async () => {
      await transport.destroy();
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    const recentContext = createRecentContext({ limit: 10 });
    attachHandlers(transport, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      botContactNames: createBotContactNames({ filePath: path.join(dir, 'names.json') }),
    });

    await transport.initialize();
    await waitFor(() => bridge.sseClients.size === 1);

    bridge.pushEvent('ep2:1', 'message', {
      id: 'cold-1',
      chatId: coldJid,
      from: coldJid,
      author: coldJid,
      fromMe: false,
      type: 'chat',
      body: 'https://hutong.biz/login',
    });
    await waitFor(() => bridge.calls.filter((c) => c.op === 'sendPoll').length === 1);
    assert.deepEqual(
      bridge.calls.map((c) => c.op),
      ['forward', 'sendText', 'sendPoll'],
    );

    bridge.calls.length = 0;
    bridge.pushEvent('ep2:2', 'message', {
      id: 'lid-1',
      chatId: lidSaved,
      from: lidSaved,
      author: lidSaved,
      fromMe: false,
      type: 'chat',
      body: 'https://hutong.biz/login',
    });
    await waitFor(() => bridge.calls.filter((c) => c.op === 'sendPoll').length === 1);
    assert.deepEqual(
      bridge.calls.map((c) => c.op),
      ['forward', 'sendText', 'sendPoll'],
    );

    const coldPoll = bridge.calls.find((c) => c.op === 'sendPoll');
    bridge.pushEvent('ep2:3', 'message_edit', {
      id: 'lid-1',
      chatId: lidSaved,
      from: lidSaved,
      author: lidSaved,
      fromMe: false,
      type: 'chat',
      body: 'hi mum',
      newBody: 'hi mum',
      prevBody: 'https://hutong.biz/login',
    });
    await waitFor(() => Boolean(queue.get(coldPoll.id)?.voidReason));

    bridge.pushEvent('ep2:4', 'message_create', {
      id: 'own-1',
      chatId: editableJid,
      from: editableJid,
      fromMe: true,
      type: 'chat',
      body: '你好',
    });
    bridge.pushEvent('ep2:5', 'message_create', {
      id: 'self-help',
      chatId: '99990000@lid',
      from: '99990000@lid',
      fromMe: true,
      type: 'chat',
      body: '幫助',
    });
    await waitFor(() => bridge.calls.some((c) => c.op === 'sendText' && c.chatId === '85299990000@c.us' && /解除/.test(c.text)));
    assert.equal(recentContext.recent('99990000@lid').length, 0);
    assert.equal(recentContext.recent(editableJid).some((turn) => turn.fromMe && turn.body === '你好'), true);
  });

  it('rejects initialize immediately when WA_BRIDGE_TOKEN is rejected with 401', async (t) => {
    const dir = tempDir();
    const bridge = await startMockBridge({ token: 'expected-token' });
    const transport = createWhatsmeowTransport({
      baseUrl: bridge.baseUrl,
      token: 'wrong-token',
      cursorPath: path.join(dir, 'cursor.json'),
      timeoutMs: 2000,
    });
    t.after(async () => {
      await transport.destroy();
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await assert.rejects(() => transport.initialize(), /401/);
  });

  it('cancels a paced automatic block when an edit arrives on the SSE stream during pacing', async (t) => {
    const dir = tempDir();
    const senderJid = '85261230099@c.us';
    const bridge = await startMockBridge({
      contacts: new Map([
        [
          senderJid,
          {
            id: senderJid,
            number: '85261230099',
            name: '',
            pushname: 'FastEditor',
            isMyContact: false,
            isMe: false,
            contactsSynced: true,
          },
        ],
      ]),
    });
    const transport = createWhatsmeowTransport({
      baseUrl: bridge.baseUrl,
      token: bridge.token,
      cursorPath: path.join(dir, 'cursor.json'),
      reconnectBaseMs: 25,
      reconnectMaxMs: 50,
    });
    t.after(async () => {
      await transport.destroy();
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    let signalPauseStarted;
    const pauseStarted = new Promise((resolve) => {
      signalPauseStarted = resolve;
    });
    let releasePause;
    const pauseGate = new Promise((resolve) => {
      releasePause = resolve;
    });
    const pacer = createActionPacer({
      env: { WA_ACTION_GAP_MS: '1000' },
      sleep: async () => {
        signalPauseStarted();
        await pauseGate;
      },
    });
    await pacer.pause();

    let editHandled = false;
    transport.on('message_edit', () => {
      editHandled = true;
    });
    attachHandlers(transport, {
      pacer,
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'queue.json') }),
      botContactNames: createBotContactNames({ filePath: path.join(dir, 'names.json') }),
    });

    await transport.initialize();
    await waitFor(() => bridge.sseClients.size === 1);

    bridge.pushEvent('ep-edit:1', 'message', {
      id: 'superseded-1',
      chatId: senderJid,
      from: senderJid,
      author: senderJid,
      fromMe: false,
      type: 'chat',
      body: 'https://hutong.biz/login',
    });
    await pauseStarted;

    bridge.pushEvent('ep-edit:2', 'message_edit', {
      id: 'superseded-1',
      chatId: senderJid,
      from: senderJid,
      author: senderJid,
      fromMe: false,
      type: 'chat',
      body: 'sorry wrong link',
      newBody: 'sorry wrong link',
      prevBody: 'https://hutong.biz/login',
    });
    await waitFor(() => editHandled);
    releasePause();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(bridge.calls.some((c) => c.op === 'blockContact'), false);
    assert.equal(bridge.calls.some((c) => c.op === 'archiveChat'), false);
  });

  it('persists SSE cursor and deduplicates self-chat unblock commands across Node restarts', async (t) => {
    const dir = tempDir();
    const prevBlockLog = process.env.BLOCK_LOG_PATH;
    const blockLogPath = path.join(dir, 'blocks.jsonl');
    process.env.BLOCK_LOG_PATH = blockLogPath;
    const cursorPath = path.join(dir, 'cursor.json');
    const aliceJid = '85261230101@c.us';
    const bobJid = '85261230102@c.us';

    fs.writeFileSync(
      blockLogPath,
      [
        JSON.stringify({ at: '2026-11-24T01:00:00Z', chatId: bobJid, digits: '85261230102', contactName: '封鎖·惡意域名', blocked: true, renamed: true, savedContact: false }),
        JSON.stringify({ at: '2026-11-24T02:00:00Z', chatId: aliceJid, digits: '85261230101', contactName: '封鎖·惡意域名', blocked: true, renamed: true, savedContact: false }),
      ].join('\n') + '\n',
    );

    const bridge = await startMockBridge({
      contacts: new Map([
        [aliceJid, { id: aliceJid, number: '85261230101', name: '封鎖·惡意域名', isMyContact: true, isMe: false, contactsSynced: true }],
        [bobJid, { id: bobJid, number: '85261230102', name: '封鎖·惡意域名', isMyContact: true, isMe: false, contactsSynced: true }],
      ]),
    });

    const makeBotTransport = () => {
      const tr = createWhatsmeowTransport({
        baseUrl: bridge.baseUrl,
        token: bridge.token,
        cursorPath,
        reconnectBaseMs: 25,
        reconnectMaxMs: 50,
      });
      attachHandlers(tr, {
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        maskClient: createStubJevlikeClient('benign'),
        env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0', BLOCK_LOG_PATH: blockLogPath },
        llmReview: { enabled: false },
        operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode.json') }),
        reviewQueue: createReviewQueue({ filePath: path.join(dir, 'queue.json') }),
        botContactNames: createBotContactNames({ filePath: path.join(dir, 'names.json') }),
      });
      return tr;
    };

    const transport1 = makeBotTransport();
    let transport2 = null;
    t.after(async () => {
      await transport1.destroy();
      if (transport2) await transport2.destroy();
      await bridge.close();
      if (prevBlockLog === undefined) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = prevBlockLog;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await transport1.initialize();
    await waitFor(() => bridge.sseClients.size === 1);

    const unblockEvt = {
      id: 'self-unblock-1',
      chatId: '85299990000@c.us',
      from: '85299990000@c.us',
      fromMe: true,
      type: 'chat',
      body: '解除',
    };
    bridge.pushEvent('ep-restart:10', 'message_create', unblockEvt);
    await waitFor(() => bridge.calls.some((c) => c.op === 'unblockContact' && c.id === aliceJid));
    await waitFor(() => fs.existsSync(cursorPath) && fs.readFileSync(cursorPath, 'utf8').includes('ep-restart:10'));
    await transport1.destroy();

    bridge.calls.length = 0;
    transport2 = makeBotTransport();
    await transport2.initialize();
    await waitFor(() => bridge.receivedLastEventIds.length >= 2);
    assert.equal(bridge.receivedLastEventIds[1], 'ep-restart:10');

    bridge.pushEvent('ep-new:1', 'message_create', unblockEvt);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(bridge.calls.some((c) => c.op === 'unblockContact'), false);
  });

  it('restarts an auto-started bridge child when it exits unexpectedly after startup', async (t) => {
    const dir = tempDir();
    const stateFile = path.join(dir, 'runs.txt');
    const mockBin = path.join(dir, 'mock-bridge.js');
    fs.writeFileSync(
      mockBin,
      [
        "'use strict';",
        "const fs = require('fs');",
        "const http = require('http');",
        `const stateFile = ${JSON.stringify(stateFile)};`,
        "const run = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) + 1 : 1;",
        "fs.writeFileSync(stateFile, String(run));",
        "const host = process.env.WA_BRIDGE_HOST || '127.0.0.1';",
        "const port = Number(process.env.WA_BRIDGE_PORT);",
        "const token = process.env.WA_BRIDGE_TOKEN;",
        "const srv = http.createServer((req, res) => {",
        "  if (req.url === '/health') {",
        "    res.writeHead(200, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ ok: true, state: 'ready', connected: true, loggedIn: true, contactsSynced: true, selfWid: '85299990000@c.us' }));",
        "    return;",
        "  }",
        "  if (req.headers.authorization !== 'Bearer ' + token) {",
        "    res.writeHead(401); res.end(); return;",
        "  }",
        "  if (req.url === '/v1/events') {",
        "    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
        "    res.flushHeaders();",
        "    if (run === 1) {",
        "      setTimeout(() => process.exit(2), 40);",
        "    } else {",
        "      const payload = JSON.stringify({ id: 'r2:1', type: 'ready', data: { selfWid: '85299990000@c.us', selfLid: 'run2@lid' } });",
        "      res.write('id: r2:1\\nevent: ready\\ndata: ' + payload + '\\n\\n');",
        "    }",
        "    return;",
        "  }",
        "  res.writeHead(404); res.end();",
        "});",
        "srv.listen(port, host);",
      ].join('\n'),
    );

    const transport = createWhatsmeowTransport({
      autoStart: true,
      binPath: process.execPath,
      binArgs: [mockBin],
      reconnectBaseMs: 30,
      reconnectMaxMs: 60,
      timeoutMs: 4000,
    });
    t.after(async () => {
      await transport.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const events = [];
    transport.on('disconnected', (reason) => events.push(`disconnected:${reason}`));
    transport.on('ready', () => events.push(`ready:${transport.getSelfLid()}`));

    await transport.initialize();
    await waitFor(() => events.includes('ready:run2@lid'), 4000);
    assert.equal(events.some((e) => e.startsWith('disconnected:')), true);
    assert.equal(Number(fs.readFileSync(stateFile, 'utf8')), 2);
  });

  it('deduplicates already-completed uncommitted SSE events on reconnect and emits ready once when restarting against a ready bridge', async (t) => {
    const dir = tempDir();
    const cursorPath = path.join(dir, 'cursor.json');
    const slowJid = '85261230201@c.us';
    const fastJid = '85261230202@c.us';

    const bridge = await startMockBridge({
      contacts: new Map([
        [slowJid, { id: slowJid, number: '85261230201', name: '', isMyContact: false, isMe: false, contactsSynced: true }],
        [fastJid, { id: fastJid, number: '85261230202', name: '', isMyContact: false, isMe: false, contactsSynced: true }],
      ]),
    });

    fs.writeFileSync(
      cursorPath,
      JSON.stringify({ cursorsByUrl: { [bridge.baseUrl]: 'ep-dup:5' }, handledSelfIds: [] }),
    );

    const transport = createWhatsmeowTransport({
      baseUrl: bridge.baseUrl,
      token: bridge.token,
      cursorPath,
      reconnectBaseMs: 25,
      reconnectMaxMs: 50,
    });
    t.after(async () => {
      await transport.destroy();
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    let readyCount = 0;
    let releaseSlow;
    const slowGate = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    let slowStarted = false;
    const handledIds = [];
    transport.on('ready', () => {
      readyCount += 1;
    });
    transport.on('message', async (msg) => {
      handledIds.push(msg.id);
      if (msg.id === 'slow-a') {
        slowStarted = true;
        await slowGate;
      } else {
        await transport.archiveChat(await msg.getChat());
      }
    });

    await transport.initialize();
    await waitFor(() => readyCount === 1);
    bridge.pushEvent('ep-dup:6', 'ready', { selfWid: '85299990000@c.us', selfLid: '99990000@lid' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(readyCount, 1);

    const evtA = { id: 'slow-a', chatId: slowJid, from: slowJid, author: slowJid, fromMe: false, type: 'chat', body: 'hi' };
    const evtB = { id: 'fast-b', chatId: fastJid, from: fastJid, author: fastJid, fromMe: false, type: 'chat', body: 'support@hutong.biz' };
    bridge.pushEvent('ep-dup:7', 'message', evtA);
    await waitFor(() => slowStarted);
    bridge.pushEvent('ep-dup:8', 'message', evtB);
    await waitFor(() => bridge.calls.filter((c) => c.op === 'archiveChat').length === 1);

    bridge.dropAllSse();
    await waitFor(() => bridge.receivedLastEventIds.length >= 2);
    assert.equal(bridge.receivedLastEventIds[1], 'ep-dup:6');

    bridge.pushEvent('ep-dup:7', 'message', evtA);
    bridge.pushEvent('ep-dup:8', 'message', evtB);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bridge.calls.filter((c) => c.op === 'archiveChat').length, 1);
    assert.deepEqual(handledIds, ['slow-a', 'fast-b']);

    releaseSlow();
    await waitFor(() => fs.readFileSync(cursorPath, 'utf8').includes('ep-dup:8'));

    bridge.dropAllSse();
    await waitFor(() => bridge.receivedLastEventIds.length >= 3);
    bridge.pushEvent('ep-restarted:1', 'ready', { selfWid: '85299990000@c.us', selfLid: '99990000@lid' });
    await waitFor(() => readyCount === 2);
    bridge.pushEvent('ep-restarted:2', 'ready', { selfWid: '85299990000@c.us', selfLid: '99990000@lid' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(readyCount, 2);
  });

  it('honors WA_BRIDGE_CURSOR_PATH in auto-start mode when explicitly configured', async (t) => {
    const dir = tempDir();
    const cursorPath = path.join(dir, 'autostart-cursor.json');
    const mockBin = path.join(dir, 'cursor-bridge.js');
    fs.writeFileSync(
      mockBin,
      [
        "'use strict';",
        "const http = require('http');",
        "const host = process.env.WA_BRIDGE_HOST || '127.0.0.1';",
        "const port = Number(process.env.WA_BRIDGE_PORT);",
        "const token = process.env.WA_BRIDGE_TOKEN;",
        "const srv = http.createServer((req, res) => {",
        "  if (req.url === '/health') {",
        "    res.writeHead(200, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ ok: true, state: 'ready', connected: true, loggedIn: true, contactsSynced: true, selfWid: '85299990000@c.us' }));",
        "    return;",
        "  }",
        "  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }",
        "  if (req.url === '/v1/events') {",
        "    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
        "    res.flushHeaders();",
        "    const payload = JSON.stringify({ id: 'as:1', type: 'message', data: { id: 'm1', chatId: '852@c.us', from: '852@c.us', body: 'hi' } });",
        "    res.write('id: as:1\\nevent: message\\ndata: ' + payload + '\\n\\n');",
        "    return;",
        "  }",
        "  res.writeHead(404); res.end();",
        "});",
        "srv.listen(port, host);",
      ].join('\n'),
    );

    const transport = createWhatsmeowTransport({
      env: { WA_BRIDGE_AUTO_START: '1', WA_BRIDGE_CURSOR_PATH: cursorPath },
      binPath: process.execPath,
      binArgs: [mockBin],
      timeoutMs: 4000,
    });
    t.after(async () => {
      await transport.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await transport.initialize();
    await waitFor(() => fs.existsSync(cursorPath) && fs.readFileSync(cursorPath, 'utf8').includes('as:1'), 4000);
  });
});
