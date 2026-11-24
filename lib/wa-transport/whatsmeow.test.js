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
});
