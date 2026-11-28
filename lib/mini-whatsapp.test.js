'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createMiniWhatsApp, canonicalizeJid } = require('./mini-whatsapp');
const { renderMiniWhatsAppHtml } = require('./mini-whatsapp-ui');
const {
  parseArgs,
  startMockLlmServer,
  buildBotEnv,
  isAllowedLoopbackHost,
  isAllowedUiOrigin,
} = require('../scripts/mini-whatsapp');
const { GUIDE_SYSTEM_PROMPT, parseGuide, SETUP_POLL_NAME, UNBLOCK_POLL_NAME } = require('./review-prompt');
const { createWhatsmeowTransport } = require('./wa-transport/whatsmeow');
const { attachHandlers } = require('../whatsapp-bot');
const { createMaskClient } = require('./jevlike-client');
const { createLlmReviewConfig } = require('./llm-review');
const { createActionPacer } = require('./action-pacer');
const { createThreadContext } = require('./thread-context');
const { createRecentContext } = require('./context-llm');
const { createOperatorState } = require('./operator-mode');
const { createReviewQueue } = require('./review-queue');
const { createLlmReviewCooldownStore } = require('./llm-review-cooldown');
const { createBotContactNames } = require('./bot-contact-names');
const { createUserRestoredChats } = require('./user-restored-chats');
const { loadMaliciousHosts } = require('./malicious-hosts');

async function waitFor(fn, { timeoutMs = 6000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function apiJson(baseUrl, pathname, { token = '', method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function startTestAiMocks(decideReply) {
  const maskRequests = [];
  const llmRequests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    if (req.method === 'POST' && req.url === '/v1/mask') {
      maskRequests.push(body);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: msgs.map(() => ({ spans: [] })) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      llmRequests.push(body);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const sys = msgs.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
      const usr = msgs.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');
      const reply = decideReply({ sys, usr, body });
      const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'test-llm',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    maskRequests,
    llmRequests,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('canonicalizeJid and loopback guard', () => {
  assert.equal(canonicalizeJid('85291234567:2@s.whatsapp.net'), '85291234567@c.us');
  assert.equal(canonicalizeJid('111222333:0@lid'), '111222333@lid');
  assert.equal(canonicalizeJid('85261110001'), '85261110001@c.us');
  assert.throws(() => createMiniWhatsApp({ host: '0.0.0.0' }), /loopback/i);
});

test('mini-whatsapp HTTP protocol, auth, endpoints, and SSE Last-Event-ID replay', async (t) => {
  const sandbox = createMiniWhatsApp({ port: 0, token: 'secret-token' });
  await sandbox.start();
  t.after(() => sandbox.close());

  const health = await apiJson(sandbox.baseUrl, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.state, 'ready');
  assert.equal(health.json.contactsSynced, true);

  const unauth = await apiJson(sandbox.baseUrl, '/v1/contact?id=85261110001@c.us');
  assert.equal(unauth.status, 401);

  const lidContact = await apiJson(sandbox.baseUrl, '/v1/contact?id=222333444@lid', {
    token: 'secret-token',
  });
  assert.equal(lidContact.status, 200);
  assert.equal(lidContact.json.isMyContact, false);
  assert.equal(lidContact.json.number, '85261110002');

  const savedPhone = await apiJson(sandbox.baseUrl, '/v1/contact?id=85261110002@c.us', {
    token: 'secret-token',
  });
  assert.equal(savedPhone.status, 200);
  assert.equal(savedPhone.json.isMyContact, true);

  sandbox.setStateFlags({ contactLookupFailing: true });
  const failingContact = await apiJson(sandbox.baseUrl, '/v1/contact?id=85261110001@c.us', {
    token: 'secret-token',
  });
  assert.equal(failingContact.status, 503);

  sandbox.setStateFlags({ contactLookupFailing: false, contactsSynced: false });
  const unsyncedUnknown = await apiJson(sandbox.baseUrl, '/v1/contact?id=85261110001@c.us', {
    token: 'secret-token',
  });
  assert.equal(unsyncedUnknown.json.isMyContact, null);
  assert.equal(unsyncedUnknown.json.contactsSynced, false);
  sandbox.setStateFlags({ contactsSynced: true });

  const lidRes = await apiJson(sandbox.baseUrl, '/v1/lid/resolve', {
    token: 'secret-token',
    method: 'POST',
    body: { ids: ['111222333@lid', '999888777@lid'] },
  });
  assert.equal(lidRes.status, 200);
  assert.deepEqual(lidRes.json.mappings, [{ lid: '111222333@lid', pn: '85261110003@c.us' }]);

  const badPoll = await apiJson(sandbox.baseUrl, '/v1/send/poll', {
    token: 'secret-token',
    method: 'POST',
    body: { chatId: sandbox.selfWid, name: 'Only One', options: ['A'] },
  });
  assert.equal(badPoll.status, 400);

  const textRes = await apiJson(sandbox.baseUrl, '/v1/send/text', {
    token: 'secret-token',
    method: 'POST',
    body: { chatId: sandbox.selfWid, text: 'hello' },
  });
  assert.equal(textRes.status, 200);
  assert.ok(textRes.json.id);

  const pollRes = await apiJson(sandbox.baseUrl, '/v1/send/poll', {
    token: 'secret-token',
    method: 'POST',
    body: { chatId: sandbox.selfWid, name: 'Choose', options: ['Opt A', 'Opt B'] },
  });
  assert.equal(pollRes.status, 200);

  const fwdMissing = await apiJson(sandbox.baseUrl, '/v1/message/forward', {
    token: 'secret-token',
    method: 'POST',
    body: { messageId: 'nonexistent', targetChatId: sandbox.selfWid },
  });
  assert.equal(fwdMissing.status, 404);

  const inbound = sandbox.sendInbound({
    chatId: '85261110001@c.us',
    body: 'First event body',
  });
  const fwdOk = await apiJson(sandbox.baseUrl, '/v1/message/forward', {
    token: 'secret-token',
    method: 'POST',
    body: { messageId: inbound.id, targetChatId: sandbox.selfWid },
  });
  assert.equal(fwdOk.status, 200);

  const labelSet = await apiJson(sandbox.baseUrl, '/v1/contact/label', {
    token: 'secret-token',
    method: 'POST',
    body: { phone: '85261110001', name: '（可疑推銷）' },
  });
  assert.equal(labelSet.status, 200);
  assert.equal(
    sandbox.snapshot().contacts.find((c) => c.id === '85261110001@c.us').name,
    '（可疑推銷）',
  );

  const mismatchedDel = await apiJson(sandbox.baseUrl, '/v1/contact/label', {
    token: 'secret-token',
    method: 'DELETE',
    body: { phone: '85261110001', expectedName: 'Delivery driver' },
  });
  assert.equal(mismatchedDel.status, 200);
  assert.equal(
    sandbox.snapshot().contacts.find((c) => c.id === '85261110001@c.us').contactMutation.operation,
    'SET',
  );
  assert.equal(
    sandbox.snapshot().actions.some((a) => a.op === 'deleteContactName' && a.phone === '85261110001'),
    false,
  );

  const labelDel = await apiJson(sandbox.baseUrl, '/v1/contact/label', {
    token: 'secret-token',
    method: 'DELETE',
    body: { phone: '85261110001', expectedName: '（可疑推銷）' },
  });
  assert.equal(labelDel.status, 200);
  const removed = sandbox.snapshot().contacts.find((c) => c.id === '85261110001@c.us');
  assert.equal(removed.name, '');
  assert.equal(removed.contactMutation, null);
  const removeAction = sandbox.snapshot().actions.find((a) => a.op === 'deleteContactName' && a.phone === '85261110001');
  assert.equal(removeAction.wireOperation, 'REMOVE');
  assert.equal(removeAction.expectedName, '（可疑推銷）');

  const blankSet = await apiJson(sandbox.baseUrl, '/v1/contact/label', {
    token: 'secret-token',
    method: 'POST',
    body: { phone: '85261110001', name: '' },
  });
  assert.equal(blankSet.status, 200);
  const blankArtifact = sandbox.snapshot().contacts.find((c) => c.id === '85261110001@c.us');
  assert.equal(blankArtifact.name, '');
  assert.equal(blankArtifact.contactMutation.operation, 'SET');
  assert.equal(blankArtifact.contactMutation.fullName, '');

  const ac = new AbortController();
  const sseRes = await fetch(`${sandbox.baseUrl}/v1/events`, {
    headers: { authorization: 'Bearer secret-token' },
    signal: ac.signal,
  });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();

  const ev1 = sandbox.sendInbound({ chatId: '85261110001@c.us', body: 'Event 1' });
  let sseText = '';
  await waitFor(async () => {
    const chunk = await reader.read();
    if (chunk.value) sseText += dec.decode(chunk.value, { stream: true });
    return sseText.includes(ev1.id);
  }, { label: 'first SSE event' });
  const idMatch = sseText.match(/id:\s*([^\r\n]+)/);
  assert.ok(idMatch);
  const firstEventId = idMatch[1].trim();
  ac.abort();

  // Emit second event while disconnected, then reconnect with Last-Event-ID.
  const ev2 = sandbox.sendInbound({ chatId: '85261110001@c.us', body: 'Event 2 missed' });
  const ac2 = new AbortController();
  const sseRes2 = await fetch(`${sandbox.baseUrl}/v1/events`, {
    headers: {
      authorization: 'Bearer secret-token',
      'last-event-id': firstEventId,
    },
    signal: ac2.signal,
  });
  const reader2 = sseRes2.body.getReader();
  let replayText = '';
  await waitFor(async () => {
    const chunk = await reader2.read();
    if (chunk.value) replayText += dec.decode(chunk.value, { stream: true });
    return replayText.includes(ev2.id);
  }, { label: 'replayed SSE event' });
  ac2.abort();
  assert.equal(replayText.includes('Event 1'), false);
  assert.equal(replayText.includes('Event 2 missed'), true);

  sandbox.reset();
  assert.equal(sandbox.snapshot().actions.length, 0);

  // Stale-epoch Last-Event-ID (after reset) should replay new epoch ready + buffered events.
  const evAfterReset = sandbox.sendInbound({ chatId: '85261110001@c.us', body: 'After reset event' });
  const ac3 = new AbortController();
  const sseRes3 = await fetch(`${sandbox.baseUrl}/v1/events`, {
    headers: {
      authorization: 'Bearer secret-token',
      'last-event-id': firstEventId,
    },
    signal: ac3.signal,
  });
  const reader3 = sseRes3.body.getReader();
  let staleReplayText = '';
  await waitFor(async () => {
    const chunk = await reader3.read();
    if (chunk.value) staleReplayText += dec.decode(chunk.value, { stream: true });
    return staleReplayText.includes(evAfterReset.id);
  }, { label: 'stale-epoch replay after reset' });
  ac3.abort();
  assert.equal(staleReplayText.includes('event: ready'), true);
  assert.equal(staleReplayText.includes('After reset event'), true);
});

test('mini-whatsapp upsertContact preserves existing pushname and blocked on partial update', () => {
  const sandbox = createMiniWhatsApp({ port: 0, token: 'upsert-token' });
  sandbox.upsertContact({ id: '85261110001@c.us', blocked: true });
  const updated = sandbox.upsertContact({
    id: '85261110001@c.us',
    isMyContact: true,
    name: 'Saved Contact',
  });
  assert.equal(updated.name, 'Saved Contact');
  assert.equal(updated.pushname, '陌生號碼 6111');
  assert.equal(updated.blocked, true);
  assert.equal(updated.isMyContact, true);
});

test('real whatsmeow transport + attachHandlers E2E inside Mini-WhatsApp without QR', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-wa-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sandbox = createMiniWhatsApp({ port: 0, token: 'e2e-token' });
  await sandbox.start();
  t.after(() => sandbox.close());

  const ai = await startTestAiMocks(({ sys, usr }) => {
    if (/Cantonese|廣東話/i.test(sys)) {
      return { guide: '【測試提示】此對話疑涉詐騙。' };
    }
    if (/confirmed malicious-host list/i.test(sys) && !/防騙呼籲|唔好信|不要點擊|切勿/i.test(usr)) {
      return { action: 'block', pitch: false, strong: true, confidence: 0.95, reason: 'listed_host' };
    }
    if (/https:\/\/<(?:URL|PII)_\d+>/.test(usr) && /驗證碼|OTP/i.test(usr)) {
      return { action: 'archive', pitch: false, strong: true, confidence: 0.94, reason: 'otp_scam' };
    }
    if (/明白，祝你生活愉快/i.test(usr)) {
      return { action: 'no_action', pitch: false, strong: false, confidence: 0.92, reason: 'benign' };
    }
    if (/投資群|保本|短炒/i.test(usr)) {
      return { action: 'no_action', pitch: true, strong: false, confidence: 0.91, reason: 'pitch' };
    }
    return { action: 'no_action', pitch: false, strong: false, confidence: 0.92, reason: 'benign' };
  });
  t.after(() => ai.close());

  const env = {
    ...process.env,
    OPERATOR_MODE: '',
    WA_TRANSPORT: 'whatsmeow',
    WA_BRIDGE_AUTO_START: '0',
    WA_BRIDGE_URL: sandbox.baseUrl,
    WA_BRIDGE_TOKEN: sandbox.token,
    WA_BRIDGE_CURSOR_PATH: path.join(dir, 'cursor.json'),
    OPERATOR_MODE_PATH: path.join(dir, 'operator.json'),
    REVIEW_QUEUE_PATH: path.join(dir, 'queue.json'),
    LLM_REVIEW_COOLDOWN_PATH: path.join(dir, 'cooldown.json'),
    BOT_CONTACT_NAMES_PATH: path.join(dir, 'bot-names.json'),
    USER_RESTORED_CHATS_PATH: path.join(dir, 'restored.json'),
    BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl'),
    WA_ACTION_GAP_MS: '0',
    JEVLIKE_BASE_URL: ai.baseUrl,
    LLM_REVIEW_ENABLED: '1',
    CONTEXT_LLM_ENABLED: '1',
    LLM_REVIEW_API_URL: `${ai.baseUrl}/v1/chat/completions`,
    LLM_REVIEW_MODEL: 'test-model',
    LLM_REVIEW_API_KEY: 'test-key',
  };
  loadMaliciousHosts();

  const transport = createWhatsmeowTransport({
    env,
    baseUrl: sandbox.baseUrl,
    token: sandbox.token,
    cursorPath: env.WA_BRIDGE_CURSOR_PATH,
  });
  const botContactNames = createBotContactNames({ filePath: env.BOT_CONTACT_NAMES_PATH });
  const userRestoredChats = createUserRestoredChats({ filePath: env.USER_RESTORED_CHATS_PATH });
  const operator = createOperatorState({ env, filePath: env.OPERATOR_MODE_PATH });
  const reviewQueue = createReviewQueue({ filePath: env.REVIEW_QUEUE_PATH });

  attachHandlers(transport, {
    env,
    maskClient: createMaskClient(env),
    llmReview: createLlmReviewConfig(env),
    pacer: createActionPacer({ env }),
    threadContext: createThreadContext({ turns: 5 }),
    recentContext: createRecentContext({ limit: 10 }),
    operator,
    reviewQueue,
    llmCooldownStore: createLlmReviewCooldownStore({ filePath: env.LLM_REVIEW_COOLDOWN_PATH, env }),
    botContactNames,
    userRestoredChats,
  });

  await transport.initialize();
  t.after(() => transport.destroy());

  // 1. Setup poll arrives -> answer Automatic mode
  const setupPoll = await waitFor(
    () => sandbox.snapshot().actions.find((a) => a.op === 'sendPoll'),
    { label: 'setup poll' },
  );
  sandbox.votePoll({
    pollId: setupPoll.id,
    selectedOptions: ['自動封鎖同封存'],
  });
  await waitFor(() => !operator.needsSetup() && operator.mode() === 'auto', {
    label: 'auto mode confirmed',
  });

  // 2. Unsaved number sends curated malicious host -> auto block + label + mute + archive + unblock poll
  sandbox.sendInbound({
    chatId: '85261110001@c.us',
    body: '請登入 http://malicious-block-test.invalid 認證帳戶',
  });
  await waitFor(
    () => sandbox.snapshot().actions.find((a) => a.op === 'blockContact' && a.id === '85261110001@c.us')
      && sandbox.snapshot().actions.find((a) => a.op === 'archiveChat' && a.chatId === '85261110001@c.us'),
    { label: 'malicious host block+archive' },
  );
  const unblockPoll = await waitFor(
    () => sandbox.snapshot().actions.find((a) => a.op === 'sendPoll' && a.name.includes('解除封鎖')),
    { label: 'unblock poll' },
  );
  sandbox.votePoll({ pollId: unblockPoll.id, selectedOptions: ['解除封鎖'] });
  await waitFor(
    () => sandbox.snapshot().actions.find((a) => a.op === 'unblockContact' && a.id === '85261110001@c.us')
      && sandbox.snapshot().actions.find((a) => a.op === 'deleteContactName' && a.phone === '85261110001' && a.wireOperation === 'REMOVE'),
    { label: 'unblock + label deletion' },
  );

  // 3. Unresolved @lid stays unblocked/unarchived -> review card -> message_edit voids open poll
  const beforePolls = sandbox.snapshot().actions.filter((a) => a.op === 'sendPoll').length;
  const beforeCardTexts = sandbox.snapshot().actions.filter((a) => a.op === 'sendText').length;
  const lidMsg = sandbox.sendInbound({
    chatId: '999888777@lid',
    body: '請傳送驗證碼去 https://fake-login.example.com',
  });
  const lidPoll = await waitFor(() => {
    const polls = sandbox.snapshot().actions.filter((a) => a.op === 'sendPoll');
    return polls.length > beforePolls ? polls[0] : null;
  }, { label: 'guided review poll for unresolved @lid' });
  const allTexts = sandbox.snapshot().actions.filter((a) => a.op === 'sendText');
  const cardTexts = allTexts.slice(0, allTexts.length - beforeCardTexts);
  assert.ok(
    cardTexts.some((t) => t.text.includes('【測試提示】此對話疑涉詐騙。') && !t.text.includes('解釋暫時出唔到')),
    'guided review card should render parsed JSON guide text',
  );
  assert.equal(
    sandbox.snapshot().chats.find((c) => c.id === '999888777@lid').archived,
    false,
  );
  sandbox.editMessage({ messageId: lidMsg.id, newBody: '唔好意思，發錯咗，係講笑。' });
  await waitFor(() => Boolean(reviewQueue.get(lidPoll.id)?.voidReason), { label: 'poll voided on edit' });
  const beforeVoidText = sandbox.snapshot().actions.filter((a) => a.op === 'sendText').length;
  sandbox.votePoll({ pollId: lidPoll.id, selectedOptions: ['只封存'] });
  await waitFor(() => {
    const texts = sandbox.snapshot().actions.filter((a) => a.op === 'sendText');
    if (texts.length <= beforeVoidText) return null;
    return texts.slice(0, texts.length - beforeVoidText).find((m) => m.text.includes('作廢'));
  }, { label: 'voided notice reply' });

  // 4. Pitch label written -> user reply -> no_action clears pitch label
  sandbox.sendInbound({
    chatId: '85261110003@c.us',
    body: '我有內部消息保證保本高回報投資群組，加入短炒賺錢',
  });
  await waitFor(
    () => sandbox.snapshot().actions.find((a) => a.op === 'saveContactName' && a.phone === '85261110003' && a.name === '（可疑推銷）'),
    { label: 'pitch label written' },
  );
  sandbox.sendUserMessage({ chatId: '85261110003@c.us', body: '唔使喇謝謝' });
  sandbox.sendInbound({ chatId: '85261110003@c.us', body: '明白，祝你生活愉快' });
  const pitchDelete = await waitFor(
    () => sandbox.snapshot().actions.find((a) => a.op === 'deleteContactName' && a.phone === '85261110003' && a.wireOperation === 'REMOVE'),
    { label: 'pitch label cleared on benign follow-up' },
  );
  assert.equal(pitchDelete.expectedName, '（可疑推銷）');
  assert.ok(
    ai.llmRequests.some((req) => JSON.stringify(req.messages).includes('user: 唔使喇謝謝')),
    'context LLM transcript should include simulated user: turn',
  );

  // 5. chat_archived (prev=true -> curr=false) records userRestoredChats -> future AI scam goes to review card only
  sandbox.setChatArchived({ chatId: '85261110003@c.us', archived: true, emitEvent: false });
  sandbox.setChatArchived({ chatId: '85261110003@c.us', archived: false, emitEvent: true });
  await waitFor(() => userRestoredChats.has('85261110003@c.us'), { label: 'userRestoredChats recorded' });
  const pollsBeforeRestored = sandbox.snapshot().actions.filter((a) => a.op === 'sendPoll').length;
  sandbox.sendInbound({
    chatId: '85261110003@c.us',
    body: '再傳驗證碼去 https://fake-login.example.com',
  });
  await waitFor(
    () => sandbox.snapshot().actions.filter((a) => a.op === 'sendPoll').length > pollsBeforeRestored,
    { label: 'restored chat review card' },
  );
  assert.equal(
    sandbox.snapshot().chats.find((c) => c.id === '85261110003@c.us').archived,
    false,
  );
});

test('mini-whatsapp CLI arg parser, stub guide JSON, isolated botEnv, and Web UI HTML', async (t) => {
  const parsed = parseArgs([
    '--bridge-port', '9001',
    '--ui-port=9002',
    '--token', 'abc',
    '--with-bot',
    '--with-stub',
    '--isolated-env',
    '--no-ui',
  ]);
  assert.equal(parsed.bridgePort, 9001);
  assert.equal(parsed.uiPort, 9002);
  assert.equal(parsed.token, 'abc');
  assert.equal(parsed.withBot, true);
  assert.equal(parsed.withStub, true);
  assert.equal(parsed.isolatedEnv, true);
  assert.equal(parsed.noUi, true);

  const mockLlm = await startMockLlmServer();
  t.after(() => new Promise((resolve) => mockLlm.server.close(() => resolve())));
  const guideRes = await fetch(mockLlm.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: GUIDE_SYSTEM_PROMPT },
        { role: 'user', content: '請輸入驗證碼' },
      ],
    }),
  });
  const guideJson = await guideRes.json();
  const parsedGuide = parseGuide(guideJson.choices[0].message.content);
  assert.equal(parsedGuide.ok, true);
  assert.ok(parsedGuide.guide && parsedGuide.guide.includes('Stub AI 提示'));

  const customHostsFile = path.join(os.tmpdir(), 'custom-empty-hosts.json');
  const botEnv = buildBotEnv({
    baseEnv: {
      OPERATOR_MODE: 'guided',
      BLOCK_ENABLED: 'false',
      HEURISTIC_ENABLED: 'false',
      LLM_REVIEW_ENABLED: 'false',
      CONTEXT_LLM_ENABLED: '0',
      LLM_REVIEW_MIN_CONFIDENCE: '0.99',
      JEVLIKE_API_KEY: 'real-worker-secret',
      MALICIOUS_HOSTS_PATH: customHostsFile,
    },
    bridgeUrl: 'http://127.0.0.1:8767',
    token: 'tok',
    stateDir: '/tmp/state',
    stubUrl: 'http://127.0.0.1:8766',
    mockLlmUrl: mockLlm.url,
    isolatedEnv: true,
  });
  assert.equal(botEnv.OPERATOR_MODE, '');
  assert.equal(botEnv.BLOCK_ENABLED, 'true');
  assert.equal(botEnv.HEURISTIC_ENABLED, 'true');
  assert.equal(botEnv.LLM_REVIEW_ENABLED, '1');
  assert.equal(botEnv.CONTEXT_LLM_ENABLED, '1');
  assert.equal(botEnv.LLM_REVIEW_MIN_CONFIDENCE, '0.7');
  assert.equal(botEnv.JEVLIKE_API_KEY, '');
  assert.equal(botEnv.MALICIOUS_HOSTS_PATH, path.join(__dirname, '..', 'data', 'malicious-hosts.json'));

  const isolatedRealMaskEnv = buildBotEnv({
    baseEnv: { JEVLIKE_API_KEY: 'real-worker-secret' },
    bridgeUrl: 'http://127.0.0.1:8767',
    token: 'tok',
    stateDir: '/tmp/state',
    isolatedEnv: true,
  });
  assert.equal(isolatedRealMaskEnv.JEVLIKE_API_KEY, 'real-worker-secret');

  const html = renderMiniWhatsAppHtml();
  assert.ok(html.includes('Mini WhatsApp Sandbox'));
  assert.ok(html.includes('/api/inbound'));
  assert.ok(html.includes('/api/vote'));
  assert.ok(html.includes('effectiveContact'));
  assert.ok(html.includes('!ct.botLabeled'));

  // Default token is randomized per invocation when WA_BRIDGE_TOKEN is unset.
  const prevTok = process.env.WA_BRIDGE_TOKEN;
  delete process.env.WA_BRIDGE_TOKEN;
  try {
    const a1 = parseArgs([]);
    const a2 = parseArgs([]);
    assert.notEqual(a1.token, 'mini-wa-token');
    assert.notEqual(a1.token, a2.token);
  } finally {
    if (prevTok !== undefined) process.env.WA_BRIDGE_TOKEN = prevTok;
  }

  // Host & Origin validation helpers block DNS rebinding and cross-origin writes.
  assert.equal(isAllowedLoopbackHost('127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedLoopbackHost('localhost:8787', 8787), true);
  assert.equal(isAllowedLoopbackHost('evil.example:8787', 8787), false);
  assert.equal(isAllowedLoopbackHost('127.0.0.1:9999', 8787), false);
  assert.equal(isAllowedUiOrigin('http://127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedUiOrigin('https://evil.example', 8787), false);

  // Primary single-message review prompt returns label/should_archive, and non-isolated buildBotEnv keeps CONTEXT_LLM_ENABLED=0.
  const primaryRes = await fetch(mockLlm.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: '{"label":"scam"|"not_scam"|"unknown","should_archive":true|false}' },
        { role: 'user', content: '請輸入驗證碼' },
      ],
    }),
  });
  const primaryJson = await primaryRes.json();
  const primaryVerdict = JSON.parse(primaryJson.choices[0].message.content);
  assert.equal(primaryVerdict.label, 'scam');
  assert.equal(primaryVerdict.should_archive, true);

  const nonIsolatedEnv = buildBotEnv({
    baseEnv: { CONTEXT_LLM_ENABLED: '0' },
    bridgeUrl: 'http://127.0.0.1:8767',
    token: 'tok',
    stateDir: '/tmp/state',
    mockLlmUrl: mockLlm.url,
    isolatedEnv: false,
  });
  assert.equal(nonIsolatedEnv.CONTEXT_LLM_ENABLED, '0');
});

test('mini-whatsapp preserves unanswered setup polls across reset, clears unblock polls, tracks botLabeled, and namespaces IDs', async (t) => {
  const s1 = createMiniWhatsApp({ port: 0, token: 'tok-1' });
  const s2 = createMiniWhatsApp({ port: 0, token: 'tok-2' });
  await s1.start();
  await s2.start();
  t.after(async () => {
    await s1.close();
    await s2.close();
  });

  const u1 = s1.sendUserMessage({ chatId: s1.selfWid, body: 'help' });
  const u2 = s2.sendUserMessage({ chatId: s2.selfWid, body: 'help' });
  assert.notEqual(u1.id, u2.id);

  const setupPollRes = await fetch(`${s1.baseUrl}/v1/send/poll`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: s1.selfWid, name: SETUP_POLL_NAME, options: ['自動封鎖同封存', '逐條問我'] }),
  });
  const { id: setupPollId } = await setupPollRes.json();

  const unblockPollRes = await fetch(`${s1.baseUrl}/v1/send/poll`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: s1.selfWid, name: UNBLOCK_POLL_NAME, options: ['解除封鎖', '保持封鎖'] }),
  });
  const { id: unblockPollId } = await unblockPollRes.json();

  s1.reset();
  const selfTimeline = s1.snapshot().timelines[s1.selfWid] || [];
  assert.equal(selfTimeline.some((m) => m.id === setupPollId), true);
  assert.equal(selfTimeline.some((m) => m.id === unblockPollId), false);

  const labelRes = await fetch(`${s1.baseUrl}/v1/contact/label`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '85261110003', name: '（可疑推銷）' }),
  });
  assert.equal(labelRes.status, 200);
  const labeled = s1.snapshot().contacts.find((c) => c.id === '85261110003@c.us');
  assert.equal(labeled.isMyContact, true);
  assert.equal(labeled.botLabeled, true);

  s1.upsertContact({ id: '85261110003@c.us', isMyContact: true, name: 'Saved Contact' });
  const saved = s1.snapshot().contacts.find((c) => c.id === '85261110003@c.us');
  assert.equal(saved.isMyContact, true);
  assert.equal(saved.botLabeled, false);
  assert.equal(saved.name, 'Saved Contact');

  // Partial update without name/pushname/title preserves custom chat title.
  s1.upsertContact({ id: '85261110002@c.us', blocked: true });
  const doctorChat = s1.snapshot().chats.find((c) => c.id === '85261110002@c.us');
  assert.equal(doctorChat.title, '陳醫生診所 (已儲存)');
});
