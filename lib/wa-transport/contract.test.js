'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../../scripts/block-log-test-setup');

const {
  WA_TRANSPORT,
  isWaTransport,
  ensureTransport,
  resolveTransportName,
  createWhatsAppTransport,
  wrapWwebjsClient,
} = require('./index');
const { attachHandlers, handleWaMessage } = require('../../whatsapp-bot');
const { createOperatorState } = require('../operator-mode');
const { createReviewQueue } = require('../review-queue');
const { createActionPacer } = require('../action-pacer');
const { createThreadContext } = require('../thread-context');
const { createRecentContext } = require('../context-llm');
const { createBotContactNames } = require('../bot-contact-names');
const { createStubJevlikeClient } = require('../../stub-jevlike');
const { llmChatResponse } = require('../test-llm');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-transport-'));
}

function createPureMockTransport({
  selfWid = '85299990000@c.us',
  selfLid = '99990000@lid',
  contacts = new Map(),
  lidMap = new Map(),
} = {}) {
  const handlers = new Map();
  const calls = [];
  let seq = 0;

  const transport = {
    [WA_TRANSPORT]: true,
    name: 'mock',
    calls,
    contacts,
    lidMap,
    async initialize() {
      calls.push({ op: 'initialize' });
    },
    async destroy() {
      calls.push({ op: 'destroy' });
    },
    getSelfWid() {
      return selfWid;
    },
    getSelfLid() {
      return selfLid;
    },
    on(event, fn) {
      handlers.set(event, fn);
    },
    async emit(event, ...args) {
      const fn = handlers.get(event);
      if (fn) return fn(...args);
      return undefined;
    },
    async sendText(chatId, text) {
      seq += 1;
      const id = `text-${seq}`;
      calls.push({ op: 'sendText', chatId, text, id });
      return { id };
    },
    async sendPoll(chatId, poll) {
      seq += 1;
      const id = `poll-${seq}`;
      calls.push({ op: 'sendPoll', chatId, poll, id });
      return { id };
    },
    async getChat(chatId) {
      return { id: chatId, isGroup: false, isChannel: false };
    },
    async getContact(contactId) {
      return contacts.get(contactId) || null;
    },
    async getChatContact(chat) {
      const id = typeof chat === 'string' ? chat : chat && chat.id;
      return contacts.get(id) || null;
    },
    async archiveChat(chat) {
      const id = typeof chat === 'string' ? chat : chat && chat.id;
      calls.push({ op: 'archiveChat', chatId: id });
    },
    async muteChat(chat) {
      const id = typeof chat === 'string' ? chat : chat && chat.id;
      calls.push({ op: 'muteChat', chatId: id });
      return true;
    },
    async unmuteChat(chat) {
      const id = typeof chat === 'string' ? chat : chat && chat.id;
      calls.push({ op: 'unmuteChat', chatId: id });
      return true;
    },
    async blockContact(contact) {
      calls.push({ op: 'blockContact', contactId: contact && contact.id });
    },
    async unblockContact(contact) {
      calls.push({ op: 'unblockContact', contactId: contact && contact.id });
    },
    async saveContactName(phone, name) {
      calls.push({ op: 'saveContactName', phone, name });
      const jid = `${phone}@c.us`;
      const prev = contacts.get(jid) || { id: jid, number: phone, isMe: false };
      contacts.set(jid, { ...prev, name, isMyContact: true });
    },
    async deleteContactName(phone) {
      calls.push({ op: 'deleteContactName', phone });
      const jid = `${phone}@c.us`;
      const prev = contacts.get(jid) || { id: jid, number: phone, isMe: false };
      contacts.set(jid, { ...prev, name: '', isMyContact: false });
    },
    async resolveLidMappings(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      return list
        .filter((id) => lidMap.has(id))
        .map((id) => ({ lid: id, pn: lidMap.get(id) }));
    },
    async isSelfChatId(chatId) {
      return Boolean(chatId && (chatId === selfWid || chatId === selfLid));
    },
  };
  return transport;
}

function makeMessage(transport, {
  id = 'msg-1',
  chatId,
  from = chatId,
  author = null,
  fromMe = false,
  type = 'chat',
  body = '',
  notifyName = 'Sender',
  isForwarded = false,
  hasQuotedMsg = false,
  quotedId = null,
  isGroup = false,
  isChannel = false,
} = {}) {
  return {
    id,
    from,
    author,
    fromMe,
    type,
    body,
    notifyName,
    isForwarded,
    hasQuotedMsg,
    async getChat() {
      return { id: chatId, isGroup, isChannel };
    },
    async getContact() {
      return transport.getContact(author || from || chatId);
    },
    async getQuotedMessageId() {
      return quotedId;
    },
    async forward(targetChatId) {
      transport.calls.push({ op: 'forward', id, targetChatId });
    },
  };
}

describe('WaTransport factory and architectural boundary', () => {
  it('defaults WA_TRANSPORT to whatsmeow, allows legacy wwebjs, and rejects unsupported values', () => {
    assert.equal(resolveTransportName({}), 'whatsmeow');
    assert.equal(resolveTransportName({ WA_TRANSPORT: '  WHATSMEOW ' }), 'whatsmeow');
    assert.equal(resolveTransportName({ WA_TRANSPORT: '  WWEBJS ' }), 'wwebjs');
    assert.throws(
      () => createWhatsAppTransport({ env: { WA_TRANSPORT: 'unknown-driver' } }),
      /Unsupported WA_TRANSPORT "unknown-driver"/,
    );
  });

  it('keeps legacy wwebjs for existing .wwebjs_auth installs without wa-bridge.db unless opted in', (t) => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upgrade-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const authPath = path.join(dir, '.wwebjs_auth');
    const dbPath = path.join(dir, 'wa-bridge.db');
    fs.mkdirSync(authPath, { recursive: true });

    assert.equal(resolveTransportName({}, { authPath, dbPath }), 'wwebjs');
    assert.equal(resolveTransportName({ WA_TRANSPORT: 'whatsmeow' }, { authPath, dbPath }), 'whatsmeow');
    assert.equal(resolveTransportName({ WA_BRIDGE_AUTO_START: '1' }, { authPath, dbPath }), 'whatsmeow');

    fs.writeFileSync(dbPath, '');
    assert.equal(resolveTransportName({}, { authPath, dbPath }), 'whatsmeow');
  });

  it('keeps whatsapp-web.js imports confined to lib/wa-transport/wwebjs.js', () => {
    const botSource = fs.readFileSync(path.join(__dirname, '..', '..', 'whatsapp-bot.js'), 'utf8');
    assert.doesNotMatch(botSource, /require\(['"]whatsapp-web\.js['"]\)/);
  });

  it('wraps legacy wwebjs clients with tri-state isMyContact, normalized votes, and dynamic capabilities', async () => {
    const events = {};
    const sent = [];
    const legacy = {
      info: { wid: { _serialized: '85299990000@c.us' } },
      on(event, fn) {
        events[event] = fn;
      },
      async sendMessage(to, body) {
        sent.push({ to, body });
        return { id: { _serialized: `s-${sent.length}` } };
      },
      async getContactById(id) {
        if (id === 'saved@c.us') return { id: { _serialized: id }, isMyContact: true, name: 'Mum' };
        if (id === 'unsaved@c.us') return { id: { _serialized: id }, isMyContact: false, name: '' };
        return { id: { _serialized: id }, name: '' };
      },
    };
    const transport = ensureTransport(legacy);
    assert.equal(isWaTransport(transport), true);
    assert.equal(ensureTransport(transport), transport);
    assert.equal(transport.saveContactName, undefined);
    assert.equal(transport.deleteContactName, undefined);
    assert.equal(transport.resolveLidMappings, undefined);

    legacy.saveOrEditAddressbookContact = async (phone, name) => {
      sent.push({ save: { phone, name } });
    };
    assert.equal(typeof transport.saveContactName, 'function');
    await transport.saveContactName('85261112222', 'label');
    assert.deepEqual(sent.at(-1), { save: { phone: '85261112222', name: 'label' } });

    assert.equal((await transport.getContact('saved@c.us')).isMyContact, true);
    assert.equal((await transport.getContact('unsaved@c.us')).isMyContact, false);
    assert.equal((await transport.getContact('unknown@c.us')).isMyContact, undefined);

    let normalizedVote = null;
    transport.on('vote_update', (vote) => {
      normalizedVote = vote;
    });
    events.vote_update({
      parentMessage: { id: { _serialized: 'poll-42' } },
      selectedOptions: [{ name: '封鎖並封存' }],
    });
    assert.deepEqual(
      {
        parentMessageId: normalizedVote.parentMessageId,
        selectedOptions: normalizedVote.selectedOptions,
      },
      { parentMessageId: 'poll-42', selectedOptions: ['封鎖並封存'] },
    );

    let archiveChange = null;
    transport.on('chat_archived', (chat, archived, wasArchived) => {
      archiveChange = { id: chat.id, isGroup: chat.isGroup, archived, wasArchived };
    });
    events.chat_archived({ id: { _serialized: '85261112222@c.us' }, isGroup: false }, false, true);
    assert.deepEqual(archiveChange, {
      id: '85261112222@c.us', isGroup: false, archived: false, wasArchived: true,
    });
    let normalizedMessage = null;
    transport.on('message_create', (msg) => {
      normalizedMessage = msg;
    });
    events.message_create({
      id: { _serialized: 'voice-1' },
      type: 'audio',
      body: '',
      async downloadMedia() {
        return { data: 'b2dn', mimetype: 'audio/ogg' };
      },
    });
    assert.deepEqual(await normalizedMessage.downloadMedia(), { data: 'b2dn', mimetype: 'audio/ogg' });

    assert.equal(transport.getSelfLid(), null);
    assert.equal(wrapWwebjsClient(transport), transport);
  });

  it('preserves driver-specific chat and contact metadata for non-wwebjs WaTransports and supports transport-less handleWaMessage', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const observed = {};
    const senderJid = '85261230009@c.us';
    const transport = createPureMockTransport({
      contacts: new Map([
        [senderJid, { id: senderJid, number: '85261230009', name: '', isMyContact: false, isMe: false, driverTag: 'whatsmeow-contact' }],
      ]),
    });
    transport.archiveChat = async (chat) => {
      observed.chatTag = chat.driverTag;
    };
    transport.blockContact = async (contact) => {
      observed.contactTag = contact.driverTag;
    };
    const msg = {
      ...makeMessage(transport, {
        id: 'meta-1',
        chatId: senderJid,
        body: 'https://hutong.biz/login',
      }),
      async getChat() {
        return { id: senderJid, isGroup: false, isChannel: false, driverTag: 'whatsmeow-chat' };
      },
    };
    await handleWaMessage(msg, {
      transport,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0', BLOCK_LOG_PATH: path.join(dir, 'blocks.jsonl') },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'queue.json') }),
      botContactNames: createBotContactNames({ filePath: path.join(dir, 'names.json') }),
    });
    assert.equal(observed.chatTag, 'whatsmeow-chat');
    assert.equal(observed.contactTag, 'whatsmeow-contact');

    let directArchived = false;
    const rawMsg = {
      id: { _serialized: 'raw-1' },
      from: '85261230010@c.us',
      fromMe: false,
      type: 'chat',
      body: '聯絡 support@hutong.biz',
      async getChat() {
        return {
          id: { _serialized: '85261230010@c.us' },
          isGroup: false,
          async archive() {
            directArchived = true;
          },
        };
      },
      async getContact() {
        return { id: { _serialized: '85261230010@c.us' }, isMyContact: false, isMe: false, name: '' };
      },
    };
    await handleWaMessage(rawMsg, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode2.json') }),
      reviewQueue: null,
    });
    assert.equal(directArchived, true);
  });
});

describe('bot orchestration through a pure WaTransport (no whatsapp-web.js objects)', () => {
  it('blocks, renames, mutes, archives, and later unblocks an unsaved malicious-host sender', async (t) => {
    const dir = tempDir();
    const prevBlockLog = process.env.BLOCK_LOG_PATH;
    process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
    t.after(() => {
      if (prevBlockLog === undefined) delete process.env.BLOCK_LOG_PATH;
      else process.env.BLOCK_LOG_PATH = prevBlockLog;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const senderJid = '85261230001@c.us';
    const transport = createPureMockTransport({
      contacts: new Map([
        [senderJid, { id: senderJid, number: '85261230001', name: '', pushname: 'Scammer', isMyContact: false, isMe: false }],
      ]),
    });
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

    await transport.emit(
      'message',
      makeMessage(transport, {
        id: 'mal-1',
        chatId: senderJid,
        body: '請登入 https://hutong.biz/login',
      }),
    );

    const ops = transport.calls.map((c) => c.op);
    assert.deepEqual(ops, [
      'blockContact',
      'saveContactName',
      'muteChat',
      'archiveChat',
      'sendText',
      'sendPoll',
    ]);
    const unblockPollCall = transport.calls.find((c) => c.op === 'sendPoll');
    assert.ok(unblockPollCall);
    assert.equal(transport.contacts.get(senderJid).name, '封鎖·惡意域名');

    await transport.emit('vote_update', {
      parentMessageId: unblockPollCall.id,
      selectedOptions: ['解除封鎖'],
    });

    const afterUnblockOps = transport.calls.slice(6).map((c) => c.op);
    assert.deepEqual(afterUnblockOps, [
      'unblockContact',
      'deleteContactName',
      'unmuteChat',
      'sendText',
    ]);
    assert.equal(transport.contacts.get(senderJid).name, '');
  });

  it('fails closed on saved contacts and unknown saved status (cold-start before App State sync)', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const [label, isMyContact] of [
      ['saved', true],
      ['unknown_cold_start', undefined],
    ]) {
      const senderJid = `8526123000${isMyContact ? '2' : '3'}@c.us`;
      const transport = createPureMockTransport({
        contacts: new Map([
          [senderJid, { id: senderJid, number: senderJid.split('@')[0], name: isMyContact ? 'Auntie' : '', pushname: 'Sender', isMyContact, isMe: false }],
        ]),
      });
      const queue = createReviewQueue({ filePath: path.join(dir, `queue-${label}.json`) });
      attachHandlers(transport, {
        pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
        threadContext: createThreadContext({ turns: 2 }),
        recentContext: null,
        maskClient: createStubJevlikeClient('benign'),
        env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
        llmReview: { enabled: false },
        operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, `mode-${label}.json`) }),
        reviewQueue: queue,
        botContactNames: createBotContactNames({ filePath: path.join(dir, `names-${label}.json`) }),
      });

      await transport.emit(
        'message',
        makeMessage(transport, {
          id: `mal-${label}`,
          chatId: senderJid,
          body: '請登入 https://hutong.biz/login',
        }),
      );

      const ops = transport.calls.map((c) => c.op);
      assert.equal(ops.includes('blockContact'), false, label);
      assert.equal(ops.includes('archiveChat'), false, label);
      assert.equal(ops.includes('saveContactName'), false, label);
      assert.deepEqual(ops, ['forward', 'sendText', 'sendPoll'], label);
    }
  });

  it('reads @lid saved status from the phone contact and fails closed when @lid cannot resolve', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const lidJid = '222333444@lid';
    const pnJid = '85261230004@c.us';
    const transport = createPureMockTransport({
      contacts: new Map([
        [lidJid, { id: lidJid, name: '', pushname: 'Uncle', isMyContact: false, isMe: false }],
        [pnJid, { id: pnJid, number: '85261230004', name: 'Uncle', isMyContact: true, isMe: false }],
      ]),
      lidMap: new Map([[lidJid, pnJid]]),
    });
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue-lid.json') });
    attachHandlers(transport, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: null,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode-lid.json') }),
      reviewQueue: queue,
      botContactNames: createBotContactNames({ filePath: path.join(dir, 'names-lid.json') }),
    });

    await transport.emit(
      'message',
      makeMessage(transport, {
        id: 'lid-saved-1',
        chatId: lidJid,
        body: 'https://hutong.biz/login',
      }),
    );
    assert.deepEqual(
      transport.calls.map((c) => c.op),
      ['forward', 'sendText', 'sendPoll'],
    );

    const unresolvedLid = '999888777@lid';
    transport.contacts.set(unresolvedLid, {
      id: unresolvedLid,
      name: '',
      isMyContact: false,
      isMe: false,
    });
    transport.calls.length = 0;
    await transport.emit(
      'message',
      makeMessage(transport, {
        id: 'lid-unresolved-1',
        chatId: unresolvedLid,
        body: 'https://hutong.biz/login',
      }),
    );
    assert.deepEqual(
      transport.calls.map((c) => c.op),
      ['forward', 'sendText', 'sendPoll'],
    );
  });

  it('voids a guided review poll on message_edit, skips @lid self-chat in recentContext, and routes self commands', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const senderJid = '85261230005@c.us';
    const transport = createPureMockTransport({
      contacts: new Map([
        [senderJid, { id: senderJid, number: '85261230005', name: '', isMyContact: false, isMe: false }],
      ]),
    });
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue-edit.json') });
    const recentContext = createRecentContext({ limit: 10 });
    attachHandlers(transport, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext,
      maskClient: createStubJevlikeClient('benign'),
      env: { LLM_REVIEW_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      llmReview: { enabled: false },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'guided' }, filePath: path.join(dir, 'mode-edit.json') }),
      reviewQueue: queue,
      botContactNames: createBotContactNames({ filePath: path.join(dir, 'names-edit.json') }),
    });

    const msg = makeMessage(transport, {
      id: 'editable-1',
      chatId: senderJid,
      body: 'https://hutong.biz/login',
    });
    await transport.emit('message', msg);
    const pollCall = transport.calls.find((c) => c.op === 'sendPoll');
    assert.ok(pollCall);

    await transport.emit('message_edit', msg, 'sorry wrong link', 'https://hutong.biz/login');
    await transport.emit('vote_update', {
      parentMessageId: pollCall.id,
      selectedOptions: ['封鎖並封存'],
    });
    assert.equal(transport.calls.some((c) => c.op === 'blockContact'), false);
    assert.match(transport.calls.at(-1).text, /已作廢/);

    await transport.emit(
      'message_create',
      makeMessage(transport, {
        id: 'own-1',
        chatId: senderJid,
        fromMe: true,
        body: '請問係邊位？',
      }),
    );
    await transport.emit(
      'message_create',
      makeMessage(transport, {
        id: 'self-help-1',
        chatId: transport.getSelfLid(),
        fromMe: true,
        body: '幫助',
      }),
    );
    assert.equal(recentContext.recent(transport.getSelfLid()).length, 0);
    assert.equal(recentContext.recent(senderJid).some((turn) => turn.fromMe === true && turn.body === '請問係邊位？'), true);
    assert.equal(transport.calls.at(-1).op, 'sendText');
    assert.equal(transport.calls.at(-1).chatId, transport.getSelfWid());
  });

  it('writes and lifts a pitch label through WaTransport without archiving or blocking', async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const senderJid = '85261230006@c.us';
    const transport = createPureMockTransport({
      contacts: new Map([
        [senderJid, { id: senderJid, number: '85261230006', name: '', isMyContact: false, isMe: false }],
      ]),
    });
    let reply = { action: 'no_action', confidence: 0.9, pitch: true, reason: 'stock pitch' };
    const botContactNames = createBotContactNames({ filePath: path.join(dir, 'names-pitch.json') });
    attachHandlers(transport, {
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      threadContext: createThreadContext({ turns: 2 }),
      recentContext: createRecentContext({ limit: 10 }),
      maskClient: createStubJevlikeClient('benign'),
      env: { CONTEXT_LLM_ENABLED: 'true', LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: (...args) => llmChatResponse(reply)(...args),
      },
      operator: createOperatorState({ env: { OPERATOR_MODE: 'auto' }, filePath: path.join(dir, 'mode-pitch.json') }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'queue-pitch.json') }),
      botContactNames,
    });

    await transport.emit(
      'message',
      makeMessage(transport, {
        id: 'pitch-1',
        chatId: senderJid,
        body: '高回報內部貼士股票群，免費帶你賺錢',
      }),
    );
    assert.deepEqual(transport.calls.map((c) => c.op), ['saveContactName']);
    assert.equal(transport.contacts.get(senderJid).name, '（可疑推銷）');

    reply = { action: 'no_action', confidence: 0.9, pitch: false, reason: 'normal chat' };
    await transport.emit(
      'message',
      makeMessage(transport, {
        id: 'pitch-2',
        chatId: senderJid,
        body: '唔好意思發錯群，請問陳生明天幾點覆診？',
      }),
    );
    assert.deepEqual(transport.calls.map((c) => c.op), ['saveContactName', 'deleteContactName']);
    assert.equal(transport.contacts.get(senderJid).name, '');
  });
});
