// @ts-check
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

const { SETUP_POLL_NAME } = require('./review-prompt');

const MAX_BODY_BYTES = 1 << 20;
const MAX_REPLAY_EVENTS = 500;
const MAX_ACTIONS = 500;
const MAX_MESSAGES_PER_CHAT = 400;

function normalizeBindHost(host = '127.0.0.1') {
  return String(host || '127.0.0.1')
    .trim()
    .replace(/^\[|\]$/g, '');
}

function isLoopbackHost(host) {
  const clean = normalizeBindHost(host).toLowerCase();
  if (!clean) return false;
  if (clean === 'localhost' || clean === '::1') return true;
  return net.isIPv4(clean) && clean.startsWith('127.');
}

function assertLoopbackHost(host) {
  const normalized = normalizeBindHost(host);
  if (!isLoopbackHost(normalized)) {
    throw new Error(`Mini-WhatsApp must bind to a loopback address (got ${host})`);
  }
  return normalized;
}

function digitsOnly(value) {
  const m = String(value || '').replace(/\D+/g, '');
  return m || '';
}

function canonicalizeJid(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  if (!input.includes('@')) {
    const digits = digitsOnly(input);
    return digits ? `${digits}@c.us` : '';
  }
  const at = input.indexOf('@');
  const rawUser = input.slice(0, at);
  const server = input.slice(at + 1).toLowerCase();
  const user = rawUser.includes(':') ? rawUser.split(':')[0] : rawUser;
  if (!user) return '';
  if (server === 's.whatsapp.net' || server === 'c.us') {
    return `${user}@c.us`;
  }
  if (server === 'lid' || server === 'g.us' || server === 'newsletter') {
    return `${user}@${server}`;
  }
  return `${user}@${server}`;
}

function isGroupJid(jid) {
  return /@g\.us$/i.test(jid);
}

function isChannelJid(jid) {
  return /@newsletter$/i.test(jid);
}

function isLidJid(jid) {
  return /@lid$/i.test(jid);
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function constantTimeTokenMatch(headerValue, expectedToken) {
  if (!expectedToken) return false;
  const auth = String(headerValue || '');
  if (!auth.startsWith('Bearer ')) return false;
  const got = Buffer.from(auth.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

const SANDBOX_PRESETS = [
  {
    id: 'official_payme',
    label: 'PayMe Official Link (PR #148)',
    chatId: '85261110001@c.us',
    sender: 'inbound',
    body: '陳生你好，我係阿明 91234567，用 PayMe 過數啦 https://payme.hsbc/demo123',
  },
  {
    id: 'lookalike_otp',
    label: 'Fake Bank + OTP Lure',
    chatId: '85261110001@c.us',
    sender: 'inbound',
    body: '滙豐銀行職員通知：你個戶口異常，請立即登入 https://hsbc-verify.evil.example/login 輸入一次性驗證碼 61234567',
  },
  {
    id: 'pitch',
    label: 'Investment Pitch -> Label',
    chatId: '111222333@lid',
    sender: 'inbound',
    body: '朋友介紹加你，我哋團隊做美股同黃金高回報短炒課程，每月穩賺 20%，有興趣了解下嗎？',
  },
  {
    id: 'malicious_host',
    label: 'Curated Malicious URL (Auto-Block)',
    chatId: '85261110001@c.us',
    sender: 'inbound',
    body: '你有一份速遞未清關，請即補交手續費 https://malicious-block-test.invalid/pay',
  },
  {
    id: 'saved_suspicious',
    label: 'Saved Clinic Alert (Guided Card)',
    chatId: '85261110002@c.us',
    sender: 'inbound',
    body: 'Click https://malicious-block-test.invalid/login',
  },
  {
    id: 'warning_report',
    label: 'Forwarded Anti-Scam Warning',
    chatId: '85261110001@c.us',
    sender: 'inbound',
    isForwarded: true,
    body: '警方防騙呼籲：唔好信假順豐短訊叫你撳 https://malicious-block-test.invalid 交錢！',
  },
  {
    id: 'user_purchase',
    label: 'User Reply (Purchase Context)',
    chatId: '85261110001@c.us',
    sender: 'user',
    body: '好，我要買兩盒，請問 PayMe 定轉數快比訂金？',
  },
];

/**
 * Stateful in-memory WhatsApp sandbox speaking the 11-endpoint wa-bridge HTTP + SSE protocol.
 * @param {{
 *   host?: string,
 *   port?: number,
 *   token?: string,
 *   selfWid?: string,
 *   selfLid?: string,
 * }} [options]
 */
function createMiniWhatsApp(options = {}) {
  const host = assertLoopbackHost(options.host || '127.0.0.1');
  const port = options.port === undefined ? 0 : Number(options.port);
  const token = String(options.token || crypto.randomBytes(24).toString('hex')).trim();
  const selfWid = canonicalizeJid(options.selfWid || '85290000000@c.us');
  const selfLid = canonicalizeJid(options.selfLid || '90000000@lid');

  let epoch = crypto.randomBytes(4).toString('hex');
  let eventSeq = 0;
  let msgSeq = 0;
  let baseUrl = '';
  let bridgeServer = null;

  let connected = true;
  let loggedIn = true;
  let contactsSynced = true;
  let contactLookupFailing = false;

  /** @type {{ id: string, epoch: string, seq: number, event: string, data: any } | null} */
  let lastReadyEvent = null;
  /** @type {Array<{ id: string, epoch: string, seq: number, event: string, data: any }>} */
  const replayBuffer = [];
  /** @type {Set<{ res: http.ServerResponse, timer: NodeJS.Timeout | null }>} */
  const sseClients = new Set();
  /** @type {Set<Function>} */
  const uiSubscribers = new Set();

  /** @type {Map<string, any>} */
  const contacts = new Map();
  /** @type {Map<string, string>} */
  const lidToPn = new Map();
  /** @type {Map<string, any>} */
  const chats = new Map();
  /** @type {Map<string, any>} */
  const messages = new Map();
  /** @type {Map<string, any[]>} */
  const timelines = new Map();
  /** @type {Map<string, any>} */
  const polls = new Map();
  /** @type {Array<any>} */
  const actions = [];

  function notifyUi() {
    for (const fn of uiSubscribers) {
      try {
        fn();
      } catch {}
    }
  }

  function recordAction(op, detail = {}) {
    actions.unshift({
      id: `act-${Date.now()}-${actions.length + 1}`,
      at: new Date().toISOString(),
      op,
      ...detail,
    });
    if (actions.length > MAX_ACTIONS) actions.length = MAX_ACTIONS;
  }

  function ensureChat(rawChatId, defaults = {}) {
    const id = canonicalizeJid(rawChatId);
    if (!id) throw new Error('valid chatId is required');
    let chat = chats.get(id);
    if (!chat) {
      chat = {
        id,
        title: defaults.title || (id === selfWid ? 'Me (Self-Chat)' : id),
        isGroup: isGroupJid(id),
        isChannel: isChannelJid(id),
        archived: Boolean(defaults.archived),
        muted: Boolean(defaults.muted),
      };
      chats.set(id, chat);
    }
    if (!timelines.has(id)) timelines.set(id, []);
    return chat;
  }

  function appendTimelineMessage(chatId, item) {
    ensureChat(chatId);
    messages.set(item.id, item);
    const list = timelines.get(chatId) || [];
    list.push(item);
    if (list.length > MAX_MESSAGES_PER_CHAT) {
      const dropped = list.shift();
      if (dropped) messages.delete(dropped.id);
    }
    timelines.set(chatId, list);
  }

  function parseEventCursor(cursor, expectedEpoch) {
    const raw = String(cursor || '').trim();
    if (!raw) return null;
    const colon = raw.indexOf(':');
    if (colon <= 0) return null;
    if (raw.slice(0, colon) !== expectedEpoch) return null;
    const seq = Number(raw.slice(colon + 1));
    if (!Number.isInteger(seq) || seq <= 0) return null;
    return seq;
  }

  function publishEvent(type, data = {}) {
    eventSeq += 1;
    const id = `${epoch}:${eventSeq}`;
    const envelope = { id, type, data };
    const record = { id, epoch, seq: eventSeq, event: type, data: envelope };
    if (type === 'ready') lastReadyEvent = record;
    else if (type === 'disconnected') lastReadyEvent = null;
    replayBuffer.push(record);
    if (replayBuffer.length > MAX_REPLAY_EVENTS) replayBuffer.shift();

    const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const client of [...sseClients]) {
      try {
        client.res.write(frame);
      } catch {
        if (client.timer) clearInterval(client.timer);
        sseClients.delete(client);
      }
    }
    notifyUi();
    return id;
  }

  /**
   * @param {{
   *   id: string,
   *   number?: string,
   *   name?: string,
   *   pushname?: string,
   *   isMyContact?: boolean | null,
   *   isMe?: boolean,
   *   blocked?: boolean,
   *   mappedPhoneId?: string | null,
   *   title?: string,
   * }} input
   */
  function upsertContact(input) {
    const {
      id,
      number,
      name,
      pushname,
      isMyContact,
      isMe,
      blocked,
      mappedPhoneId,
      title,
    } = input || {};
    const cid = canonicalizeJid(id);
    if (!cid) throw new Error('contact id is required');
    const prev = contacts.get(cid) || {};
    const computedNumber =
      number ||
      prev.number ||
      (cid.endsWith('@c.us') ? cid.split('@')[0] : '');
    const record = {
      id: cid,
      number: computedNumber,
      name: name !== undefined ? String(name) : (prev.name || ''),
      pushname: pushname !== undefined ? String(pushname) : (prev.pushname || ''),
      isMyContact:
        isMyContact === undefined
          ? (prev.isMyContact === undefined ? false : prev.isMyContact)
          : (isMyContact === null ? null : Boolean(isMyContact)),
      isMe: Boolean((isMe !== undefined ? isMe : prev.isMe) || cid === selfWid || cid === selfLid),
      blocked: blocked !== undefined ? Boolean(blocked) : Boolean(prev.blocked),
      botLabeled:
        name !== undefined || isMyContact !== undefined
          ? false
          : Boolean(prev.botLabeled),
    };
    contacts.set(cid, record);

    if (isLidJid(cid) && mappedPhoneId) {
      const pn = canonicalizeJid(mappedPhoneId);
      if (pn) lidToPn.set(cid, pn);
    } else if (isLidJid(cid) && mappedPhoneId === null) {
      lidToPn.delete(cid);
    }

    const prevChat = chats.get(cid);
    const nextTitle =
      title || record.name || record.pushname || (prevChat && prevChat.title) || cid;
    const chat = ensureChat(cid, { title: nextTitle });
    if (title !== undefined || name !== undefined || pushname !== undefined) {
      chat.title = nextTitle;
    }
    notifyUi();
    return record;
  }

  function seedDefaultFixtures() {
    contacts.clear();
    lidToPn.clear();
    chats.clear();
    messages.clear();
    timelines.clear();
    polls.clear();
    actions.length = 0;

    connected = true;
    loggedIn = true;
    contactsSynced = true;
    contactLookupFailing = false;

    upsertContact({
      id: selfWid,
      name: '我自己（Self-Chat）',
      pushname: 'Me',
      isMyContact: true,
      isMe: true,
      title: '我自己（Self-Chat / 指令及審查卡）',
    });
    lidToPn.set(selfLid, selfWid);

    upsertContact({
      id: '85261110001@c.us',
      name: '',
      pushname: '陌生號碼 6111',
      isMyContact: false,
      title: '陌生號碼 6111 (未儲存)',
    });
    upsertContact({
      id: '85261110002@c.us',
      name: '陳醫生診所',
      pushname: '陳醫生診所',
      isMyContact: true,
      title: '陳醫生診所 (已儲存)',
    });
    upsertContact({
      id: '85261110003@c.us',
      name: '',
      pushname: 'LID 投資顧問',
      isMyContact: false,
      title: 'LID 投資顧問 (手機號)',
    });
    upsertContact({
      id: '111222333@lid',
      name: '',
      pushname: 'LID 投資顧問',
      isMyContact: false,
      mappedPhoneId: '85261110003@c.us',
      title: '111222333@lid -> 85261110003',
    });
    upsertContact({
      id: '222333444@lid',
      name: '',
      pushname: '陳醫生診所 (LID)',
      isMyContact: false,
      mappedPhoneId: '85261110002@c.us',
      title: '222333444@lid -> 陳醫生診所 (已儲存)',
    });
    upsertContact({
      id: '999888777@lid',
      name: '',
      pushname: '未解析 LID 陌生號',
      isMyContact: false,
      title: '999888777@lid (未解析 LID)',
    });
    ensureChat('120363000111@g.us', { title: '大埔街坊群組 (Group)' });
  }

  function healthStatus() {
    let state = 'connecting';
    if (connected && loggedIn) state = 'ready';
    else if (connected) state = 'awaiting_qr';
    return {
      ok: true,
      state,
      connected,
      loggedIn,
      contactsSynced,
      selfWid,
      selfLid,
    };
  }

  function resolveContactPayload(rawId) {
    const id = canonicalizeJid(rawId);
    if (!id) return null;
    const rec = contacts.get(id);
    const pnJid = isLidJid(id) ? lidToPn.get(id) : '';
    const pnDigits = id.endsWith('@c.us')
      ? id.split('@')[0]
      : pnJid && pnJid.endsWith('@c.us')
        ? pnJid.split('@')[0]
        : '';
    if (!rec) {
      return {
        id,
        number: id.endsWith('@c.us') ? id.split('@')[0] : '',
        name: '',
        pushname: '',
        isMyContact: contactsSynced ? false : null,
        isMe: id === selfWid || id === selfLid,
        contactsSynced,
      };
    }
    return {
      id: rec.id,
      number: rec.number || pnDigits,
      name: rec.name || '',
      pushname: rec.pushname || '',
      isMyContact: contactsSynced ? rec.isMyContact : (rec.isMyContact ? true : null),
      isMe: Boolean(rec.isMe || id === selfWid || id === selfLid),
      contactsSynced,
    };
  }

  function sendInbound({
    chatId,
    senderId = '',
    body = '',
    isForwarded = false,
    quotedId = '',
    notifyName = '',
    type = 'chat',
  }) {
    const cid = canonicalizeJid(chatId);
    if (!cid) throw new Error('chatId is required');
    const author = senderId ? canonicalizeJid(senderId) : cid;
    ensureChat(cid);
    const contact = contacts.get(author);
    msgSeq += 1;
    const id = `sim-${epoch}-in-${msgSeq}`;
    const item = {
      id,
      chatId: cid,
      from: cid,
      author,
      fromMe: false,
      direction: 'inbound',
      type,
      body: String(body || ''),
      notifyName: notifyName || (contact && (contact.name || contact.pushname)) || author,
      isForwarded: Boolean(isForwarded),
      hasQuotedMsg: Boolean(quotedId),
      quotedId: quotedId || null,
      edited: false,
      ts: new Date().toISOString(),
    };
    appendTimelineMessage(cid, item);
    publishEvent('message', {
      id: item.id,
      chatId: item.chatId,
      from: item.from,
      author: item.author,
      fromMe: false,
      type: item.type,
      body: item.body,
      notifyName: item.notifyName,
      isForwarded: item.isForwarded,
      hasQuotedMsg: item.hasQuotedMsg,
      quotedId: item.quotedId || undefined,
      isGroup: isGroupJid(cid),
      isChannel: isChannelJid(cid),
    });
    return item;
  }

  function sendUserMessage({ chatId, body = '', quotedId = '', type = 'chat' }) {
    const cid = canonicalizeJid(chatId);
    if (!cid) throw new Error('chatId is required');
    ensureChat(cid);
    msgSeq += 1;
    const id = `sim-${epoch}-user-${msgSeq}`;
    const item = {
      id,
      chatId: cid,
      from: selfWid,
      author: selfWid,
      fromMe: true,
      direction: 'user',
      type,
      body: String(body || ''),
      notifyName: 'Me',
      isForwarded: false,
      hasQuotedMsg: Boolean(quotedId),
      quotedId: quotedId || null,
      edited: false,
      ts: new Date().toISOString(),
    };
    appendTimelineMessage(cid, item);
    publishEvent('message_create', {
      id: item.id,
      chatId: item.chatId,
      from: item.from,
      author: item.author,
      fromMe: true,
      type: item.type,
      body: item.body,
      notifyName: item.notifyName,
      isForwarded: false,
      hasQuotedMsg: item.hasQuotedMsg,
      quotedId: item.quotedId || undefined,
      isGroup: isGroupJid(cid),
      isChannel: isChannelJid(cid),
    });
    return item;
  }

  function editMessage({ messageId, newBody }) {
    const target = messages.get(String(messageId || ''));
    if (!target) throw new Error(`message not found: ${messageId}`);
    const prevBody = target.body;
    target.body = String(newBody == null ? '' : newBody);
    target.edited = true;
    target.editedAt = new Date().toISOString();
    publishEvent('message_edit', {
      id: target.id,
      chatId: target.chatId,
      from: target.from,
      author: target.author,
      fromMe: Boolean(target.fromMe),
      type: target.type,
      body: target.body,
      newBody: target.body,
      prevBody,
      notifyName: target.notifyName,
      isForwarded: Boolean(target.isForwarded),
      hasQuotedMsg: Boolean(target.hasQuotedMsg),
      quotedId: target.quotedId || undefined,
      isGroup: isGroupJid(target.chatId),
      isChannel: isChannelJid(target.chatId),
    });
    return target;
  }

  function votePoll({ pollId, selectedOptions }) {
    const poll = polls.get(String(pollId || ''));
    if (!poll) throw new Error(`poll not found: ${pollId}`);
    const chosen = (Array.isArray(selectedOptions) ? selectedOptions : [selectedOptions])
      .map((s) => String(s))
      .filter(Boolean);
    poll.selectedOptions = chosen;
    const msg = messages.get(poll.id);
    if (msg && msg.poll) {
      msg.poll.selectedOptions = chosen;
    }
    publishEvent('vote_update', {
      parentMessageId: poll.id,
      selectedOptions: chosen,
    });
    return poll;
  }

  function setChatArchived({ chatId, archived, emitEvent = true }) {
    const chat = ensureChat(chatId);
    const wasArchived = Boolean(chat.archived);
    chat.archived = Boolean(archived);
    if (emitEvent) {
      publishEvent('chat_archived', {
        chatId: chat.id,
        isGroup: chat.isGroup,
        isChannel: chat.isChannel,
        archived: chat.archived,
        wasArchived,
      });
    } else {
      notifyUi();
    }
    return { chatId: chat.id, archived: chat.archived, wasArchived };
  }

  /**
   * @param {{
   *   connected?: boolean,
   *   loggedIn?: boolean,
   *   contactsSynced?: boolean,
   *   contactLookupFailing?: boolean,
   *   emitEvent?: string,
   * }} [flags]
   */
  function setStateFlags({
    connected: nextConnected,
    loggedIn: nextLoggedIn,
    contactsSynced: nextSynced,
    contactLookupFailing: nextFailing,
    emitEvent = '',
  } = {}) {
    if (typeof nextConnected === 'boolean') connected = nextConnected;
    if (typeof nextLoggedIn === 'boolean') loggedIn = nextLoggedIn;
    if (typeof nextSynced === 'boolean') contactsSynced = nextSynced;
    if (typeof nextFailing === 'boolean') contactLookupFailing = nextFailing;
    if (emitEvent === 'ready') {
      publishEvent('ready', { selfWid, selfLid });
    } else if (emitEvent === 'disconnected') {
      publishEvent('disconnected', { reason: 'simulated_disconnect' });
    } else {
      notifyUi();
    }
    return healthStatus();
  }

  async function handleBridgeRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, healthStatus());
      return;
    }

    if (!constantTimeTokenMatch(req.headers.authorization, token)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      const lastEventId = String(req.headers['last-event-id'] || '').trim();
      if (lastEventId) {
        const lastSeq = parseEventCursor(lastEventId, epoch);
        const toReplay = [];
        if (lastSeq !== null) {
          for (const item of replayBuffer) {
            if (item.seq > lastSeq) toReplay.push(item);
          }
        } else {
          if (lastReadyEvent && !replayBuffer.some((item) => item.id === lastReadyEvent.id)) {
            toReplay.push(lastReadyEvent);
          }
          toReplay.push(...replayBuffer);
        }
        for (const item of toReplay) {
          res.write(`id: ${item.id}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
        }
      }
      const client = { res, timer: /** @type {NodeJS.Timeout | null} */ (null) };
      client.timer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          if (client.timer) clearInterval(client.timer);
          sseClients.delete(client);
        }
      }, 20000);
      sseClients.add(client);
      req.on('close', () => {
        if (client.timer) clearInterval(client.timer);
        sseClients.delete(client);
        notifyUi();
      });
      notifyUi();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/contact') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) {
        writeJson(res, 400, { error: 'id query parameter is required' });
        return;
      }
      if (contactLookupFailing) {
        writeJson(res, 503, { error: 'simulated contact lookup failure' });
        return;
      }
      const payload = resolveContactPayload(id);
      if (!payload) {
        writeJson(res, 400, { error: 'invalid contact id' });
        return;
      }
      writeJson(res, 200, payload);
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJson(res, /** @type {any} */ (err).status || 400, { error: /** @type {Error} */ (err).message });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/lid/resolve') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const mappings = [];
      for (const rawId of ids) {
        const cid = canonicalizeJid(rawId);
        if (!cid) continue;
        if (isLidJid(cid) && lidToPn.has(cid)) {
          mappings.push({ lid: cid, pn: lidToPn.get(cid) });
        } else if (cid.endsWith('@c.us')) {
          for (const [lid, pn] of lidToPn.entries()) {
            if (pn === cid) mappings.push({ lid, pn });
          }
        }
      }
      writeJson(res, 200, { mappings });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/send/text') {
      const chatId = canonicalizeJid(body.chatId);
      const text = typeof body.text === 'string' ? body.text : '';
      if (!chatId || !text) {
        writeJson(res, 400, { error: 'chatId and text are required' });
        return;
      }
      msgSeq += 1;
      const id = `sim-${epoch}-bot-text-${msgSeq}`;
      appendTimelineMessage(chatId, {
        id,
        chatId,
        from: selfWid,
        author: selfWid,
        fromMe: true,
        direction: 'bot',
        type: 'chat',
        body: text,
        edited: false,
        ts: new Date().toISOString(),
      });
      recordAction('sendText', { chatId, id, text });
      notifyUi();
      writeJson(res, 200, { id });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/send/poll') {
      const chatId = canonicalizeJid(body.chatId);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const optionsList = Array.isArray(body.options) ? body.options.map((o) => String(o)).filter(Boolean) : [];
      if (!chatId || !name || optionsList.length < 2) {
        writeJson(res, 400, { error: 'chatId, name, and at least 2 options are required' });
        return;
      }
      msgSeq += 1;
      const id = `sim-${epoch}-bot-poll-${msgSeq}`;
      const pollRecord = {
        id,
        chatId,
        name,
        options: optionsList,
        allowMultipleAnswers: Boolean(body.allowMultipleAnswers),
        selectedOptions: [],
      };
      polls.set(id, pollRecord);
      appendTimelineMessage(chatId, {
        id,
        chatId,
        from: selfWid,
        author: selfWid,
        fromMe: true,
        direction: 'bot',
        type: 'poll',
        body: name,
        poll: { ...pollRecord },
        ts: new Date().toISOString(),
      });
      recordAction('sendPoll', { chatId, id, name, options: optionsList });
      notifyUi();
      writeJson(res, 200, { id });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/message/forward') {
      const targetChatId = canonicalizeJid(body.targetChatId);
      const sourceId = String(body.messageId || '').trim();
      if (!sourceId || !targetChatId) {
        writeJson(res, 400, { error: 'messageId and targetChatId are required' });
        return;
      }
      const sourceMsg = messages.get(sourceId);
      if (!sourceMsg) {
        writeJson(res, 404, { error: 'source message not found' });
        return;
      }
      msgSeq += 1;
      const id = `sim-${epoch}-bot-fwd-${msgSeq}`;
      appendTimelineMessage(targetChatId, {
        id,
        chatId: targetChatId,
        from: selfWid,
        author: selfWid,
        fromMe: true,
        direction: 'bot',
        type: 'chat',
        body: sourceMsg.body,
        forwardedFrom: sourceMsg.chatId,
        isForwarded: true,
        ts: new Date().toISOString(),
      });
      recordAction('forwardMessage', { messageId: sourceId, targetChatId, id });
      notifyUi();
      writeJson(res, 200, { id });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/archive') {
      const chatId = canonicalizeJid(body.chatId);
      if (!chatId) {
        writeJson(res, 400, { error: 'chatId is required' });
        return;
      }
      const archived = body.archived === undefined ? true : Boolean(body.archived);
      const chat = ensureChat(chatId);
      chat.archived = archived;
      recordAction(archived ? 'archiveChat' : 'unarchiveChat', { chatId });
      notifyUi();
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/mute') {
      const chatId = canonicalizeJid(body.chatId);
      if (!chatId) {
        writeJson(res, 400, { error: 'chatId is required' });
        return;
      }
      const muted = body.muted === undefined ? true : Boolean(body.muted);
      const chat = ensureChat(chatId);
      chat.muted = muted;
      recordAction(muted ? 'muteChat' : 'unmuteChat', { chatId });
      notifyUi();
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/contact/block') {
      const cid = canonicalizeJid(body.id);
      if (!cid) {
        writeJson(res, 400, { error: 'id is required' });
        return;
      }
      const blocked = body.blocked === undefined ? true : Boolean(body.blocked);
      const existing = contacts.get(cid);
      if (existing) {
        existing.blocked = blocked;
      } else {
        upsertContact({ id: cid, isMyContact: false, blocked });
      }
      recordAction(blocked ? 'blockContact' : 'unblockContact', { id: cid });
      notifyUi();
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/contact/label') {
      const digits = digitsOnly(body.phone);
      if (!digits) {
        writeJson(res, 400, { error: 'phone is required' });
        return;
      }
      const jid = `${digits}@c.us`;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const existing = contacts.get(jid) || { id: jid, number: digits, pushname: '', isMe: false, blocked: false };
      existing.name = name;
      existing.isMyContact = Boolean(name);
      existing.botLabeled = Boolean(name);
      contacts.set(jid, existing);
      const chat = ensureChat(jid);
      chat.title = name || existing.pushname || jid;
      recordAction(name ? 'saveContactName' : 'deleteContactName', { phone: digits, name });
      notifyUi();
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  }

  function snapshot() {
    const timelineObj = {};
    for (const [cid, msgs] of timelines.entries()) {
      timelineObj[cid] = msgs;
    }
    const lidObj = {};
    for (const [lid, pn] of lidToPn.entries()) {
      lidObj[lid] = pn;
    }
    return {
      baseUrl,
      token,
      selfWid,
      selfLid,
      health: healthStatus(),
      contactLookupFailing,
      sseClientsCount: sseClients.size,
      chats: [...chats.values()],
      contacts: [...contacts.values()],
      lidMappings: lidObj,
      timelines: timelineObj,
      actions: [...actions],
      presets: SANDBOX_PRESETS,
    };
  }

  seedDefaultFixtures();

  return {
    get baseUrl() {
      return baseUrl;
    },
    token,
    selfWid,
    selfLid,
    SANDBOX_PRESETS,
    canonicalizeJid,
    snapshot,
    reset() {
      const openSetupPolls = [...polls.values()].filter(
        (p) => p.name === SETUP_POLL_NAME && (!Array.isArray(p.selectedOptions) || p.selectedOptions.length === 0),
      );
      const openPollMessages = openSetupPolls
        .map((p) => messages.get(p.id))
        .filter(Boolean);
      seedDefaultFixtures();
      for (const pollRecord of openSetupPolls) {
        polls.set(pollRecord.id, pollRecord);
      }
      for (const item of openPollMessages) {
        appendTimelineMessage(item.chatId, item);
      }
      epoch = crypto.randomBytes(4).toString('hex');
      lastReadyEvent = null;
      replayBuffer.length = 0;
      notifyUi();
      publishEvent('ready', { selfWid, selfLid });
    },
    subscribe(fn) {
      uiSubscribers.add(fn);
      return () => uiSubscribers.delete(fn);
    },
    sendInbound,
    sendUserMessage,
    editMessage,
    votePoll,
    setChatArchived,
    upsertContact,
    setStateFlags,
    async start() {
      if (bridgeServer) return { baseUrl, token };
      bridgeServer = http.createServer((req, res) => {
        void handleBridgeRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            writeJson(res, 500, { error: err && err.message ? err.message : String(err) });
          }
        });
      });
      await new Promise((resolve, reject) => {
        bridgeServer.once('error', reject);
        bridgeServer.listen(port, host, () => {
          bridgeServer.removeListener('error', reject);
          const addr = bridgeServer.address();
          const boundPort = addr && typeof addr === 'object' ? addr.port : port;
          baseUrl = `http://${host}:${boundPort}`;
          resolve();
        });
      });
      return { baseUrl, token };
    },
    async close() {
      for (const client of [...sseClients]) {
        clearInterval(client.timer);
        try {
          client.res.end();
        } catch {}
      }
      sseClients.clear();
      if (bridgeServer) {
        const srv = bridgeServer;
        bridgeServer = null;
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        await new Promise((resolve) => srv.close(() => resolve()));
      }
    },
  };
}

module.exports = {
  SANDBOX_PRESETS,
  canonicalizeJid,
  createMiniWhatsApp,
};
