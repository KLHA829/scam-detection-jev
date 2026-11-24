// @ts-check
'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WA_TRANSPORT } = require('./wwebjs');
const log = require('../log');

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8767';
const DEFAULT_TIMEOUT_MS = 15000;
const INITIAL_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 5000;

function isLoopbackHostname(hostname) {
  const clean = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (clean === 'localhost' || clean === '::1') return true;
  return net.isIPv4(clean) && clean.startsWith('127.');
}

function validateBridgeBaseUrl(rawUrl) {
  const input = String(rawUrl || DEFAULT_BRIDGE_URL).trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid WA_BRIDGE_URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`WA_BRIDGE_URL must use http or https: ${input}`);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(`WA_BRIDGE_URL must point to loopback (127.0.0.1, localhost, or ::1): ${input}`);
  }
  return parsed.origin;
}

function parseTimeoutMs(raw, fallback = DEFAULT_TIMEOUT_MS) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error('failed to allocate loopback port'));
        else resolve(port);
      });
    });
  });
}

function defaultBridgeBinaryPath() {
  const exe = process.platform === 'win32' ? 'wa-bridge.exe' : 'wa-bridge';
  return path.join(__dirname, '..', '..', 'wa-bridge', exe);
}

function normalizeContactPayload(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    id: typeof data.id === 'string' && data.id ? data.id : null,
    number: typeof data.number === 'string' && data.number ? data.number : undefined,
    name: typeof data.name === 'string' ? data.name : undefined,
    pushname: typeof data.pushname === 'string' ? data.pushname : undefined,
    isMyContact: typeof data.isMyContact === 'boolean' ? data.isMyContact : undefined,
    isMe: Boolean(data.isMe),
  };
}

function parseSseBlock(block) {
  let id = '';
  let event = 'message';
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon >= 0 ? rawLine.slice(0, colon) : rawLine;
    let value = colon >= 0 ? rawLine.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  try {
    return { id, event, payload: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   baseUrl?: string,
 *   token?: string,
 *   timeoutMs?: number,
 *   reconnectBaseMs?: number,
 *   reconnectMaxMs?: number,
 *   autoStart?: boolean,
 *   binPath?: string,
 *   dbPath?: string,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
function createWhatsmeowTransport(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required for whatsmeow transport');
  }

  const autoStart =
    options.autoStart !== undefined
      ? Boolean(options.autoStart)
      : env.WA_BRIDGE_AUTO_START === '1' || String(env.WA_BRIDGE_AUTO_START || '').toLowerCase() === 'true';
  const binPath = options.binPath || env.WA_BRIDGE_BIN || defaultBridgeBinaryPath();
  const dbPath = options.dbPath || env.WA_BRIDGE_DB_PATH || path.join(process.cwd(), 'wa-bridge.db');
  const timeoutMs = parseTimeoutMs(options.timeoutMs ?? env.WA_BRIDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const reconnectBaseMs = parseTimeoutMs(options.reconnectBaseMs, INITIAL_RECONNECT_MS);
  const reconnectMaxMs = parseTimeoutMs(options.reconnectMaxMs, MAX_RECONNECT_MS);

  let baseUrl = autoStart
    ? (options.baseUrl || env.WA_BRIDGE_URL ? validateBridgeBaseUrl(options.baseUrl || env.WA_BRIDGE_URL) : '')
    : validateBridgeBaseUrl(options.baseUrl || env.WA_BRIDGE_URL || DEFAULT_BRIDGE_URL);
  let token = String(options.token ?? env.WA_BRIDGE_TOKEN ?? '').trim();

  if (!autoStart && !token) {
    throw new Error('WA_BRIDGE_TOKEN is required when WA_TRANSPORT=whatsmeow');
  }

  /** @type {Map<string, Array<Function>>} */
  const listeners = new Map();
  let selfWid = null;
  let selfLid = null;
  let lastEventId = '';
  let destroyed = false;
  let initialized = false;
  /** @type {AbortController | null} */
  let sseAbort = null;
  /** @type {NodeJS.Timeout | null} */
  let reconnectTimer = null;
  /** @type {import('child_process').ChildProcess | null} */
  let bridgeChild = null;
  /** @type {(() => void) | null} */
  let exitCleanup = null;

  async function emit(event, ...args) {
    const list = listeners.get(event);
    if (!list || list.length === 0) return;
    for (const fn of [...list]) {
      await fn(...args);
    }
  }

  async function apiRequest(method, urlPath, body) {
    if (!baseUrl) throw new Error('wa-bridge is not initialized');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      /** @type {Record<string, string>} */
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      /** @type {RequestInit} */
      const init = { method, headers, signal: ac.signal };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetchImpl(`${baseUrl}${urlPath}`, init);
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (!res.ok) {
        const msg = (json && json.error) || `wa-bridge HTTP ${res.status}`;
        const err = new Error(msg);
        /** @type {any} */ (err).status = res.status;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshHealth() {
    const health = await apiRequest('GET', '/health');
    if (health && typeof health.selfWid === 'string' && health.selfWid) {
      selfWid = health.selfWid;
    }
    if (health && typeof health.selfLid === 'string' && health.selfLid) {
      selfLid = health.selfLid;
    }
    return health;
  }

  function buildMessageObject(data) {
    const id = typeof data.id === 'string' && data.id ? data.id : null;
    const chatId = typeof data.chatId === 'string' && data.chatId ? data.chatId : data.from || null;
    const senderId = data.author || data.from || chatId;
    const msg = {
      id,
      from: typeof data.from === 'string' && data.from ? data.from : chatId,
      author: typeof data.author === 'string' && data.author ? data.author : null,
      fromMe: Boolean(data.fromMe),
      type: typeof data.type === 'string' && data.type ? data.type : 'chat',
      body: typeof data.body === 'string' ? data.body : '',
      isForwarded: data.isForwarded === true,
      notifyName: typeof data.notifyName === 'string' && data.notifyName ? data.notifyName : undefined,
      hasQuotedMsg: Boolean(data.hasQuotedMsg || data.quotedId),
      async getChat() {
        return {
          id: chatId,
          isGroup: Boolean(data.isGroup),
          isChannel: Boolean(data.isChannel),
        };
      },
      async getContact() {
        if (!senderId) return null;
        return transport.getContact(senderId);
      },
      async getQuotedMessageId() {
        return typeof data.quotedId === 'string' && data.quotedId ? data.quotedId : null;
      },
      async forward(targetChatId) {
        if (!id) throw new Error('message id unavailable for forward');
        await apiRequest('POST', '/v1/message/forward', {
          messageId: id,
          targetChatId,
        });
      },
    };
    return msg;
  }

  async function dispatchBridgeEvent(frame) {
    if (frame.id) lastEventId = frame.id;
    const envelope = frame.payload || {};
    const type = envelope.type || frame.event;
    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};

    if (type === 'qr') {
      if (typeof data.qr === 'string' && data.qr) await emit('qr', data.qr);
      return;
    }
    if (type === 'authenticated') {
      await emit('authenticated');
      return;
    }
    if (type === 'auth_failure') {
      await emit('auth_failure', data.reason || 'auth_failure');
      return;
    }
    if (type === 'ready') {
      if (typeof data.selfWid === 'string' && data.selfWid) selfWid = data.selfWid;
      if (typeof data.selfLid === 'string' && data.selfLid) selfLid = data.selfLid;
      await emit('ready');
      return;
    }
    if (type === 'disconnected') {
      await emit('disconnected', data.reason || 'disconnected');
      return;
    }
    if (type === 'message') {
      await emit('message', buildMessageObject(data));
      return;
    }
    if (type === 'message_create') {
      await emit('message_create', buildMessageObject(data));
      return;
    }
    if (type === 'message_edit') {
      const msg = buildMessageObject(data);
      const newBody = typeof data.newBody === 'string' ? data.newBody : msg.body;
      const prevBody = typeof data.prevBody === 'string' ? data.prevBody : null;
      await emit('message_edit', msg, newBody, prevBody);
      return;
    }
    if (type === 'vote_update') {
      await emit('vote_update', {
        parentMessageId: typeof data.parentMessageId === 'string' ? data.parentMessageId : null,
        selectedOptions: Array.isArray(data.selectedOptions)
          ? data.selectedOptions.map((s) => String(s)).filter(Boolean)
          : [],
      });
    }
  }

  async function consumeSseOnce(signal) {
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    const res = await fetchImpl(`${baseUrl}/v1/events`, {
      method: 'GET',
      headers,
      signal,
    });
    if (!res.ok) {
      throw new Error(`wa-bridge SSE HTTP ${res.status}`);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('wa-bridge SSE response has no readable body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const match = buffer.match(/\r?\n\r?\n/);
          if (!match || match.index === undefined) break;
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const frame = parseSseBlock(block);
          if (frame) await dispatchBridgeEvent(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const frame = parseSseBlock(buffer);
        if (frame) await dispatchBridgeEvent(frame);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  function scheduleSseLoop() {
    let delay = reconnectBaseMs;

    const run = async () => {
      while (!destroyed) {
        const ac = new AbortController();
        sseAbort = ac;
        const startedAt = Date.now();
        try {
          await consumeSseOnce(ac.signal);
        } catch (err) {
          if (destroyed || ac.signal.aborted) return;
          log.warn('wa-bridge SSE disconnected; retrying', {
            error: err && err.message ? err.message : String(err),
          });
        } finally {
          if (sseAbort === ac) sseAbort = null;
        }
        if (destroyed) return;
        if (Date.now() - startedAt > 5000) delay = reconnectBaseMs;
        await new Promise((resolve) => {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            resolve();
          }, delay);
        });
        delay = Math.min(delay * 2, reconnectMaxMs);
      }
    };

    void run();
  }

  async function spawnBridgeIfNeeded() {
    if (!autoStart) return;
    if (!token) token = crypto.randomBytes(32).toString('hex');
    const port = baseUrl ? new URL(baseUrl).port || '8767' : String(await allocateLoopbackPort());
    if (!baseUrl) baseUrl = `http://127.0.0.1:${port}`;

    const child = spawn(binPath, [], {
      env: {
        ...env,
        WA_BRIDGE_HOST: '127.0.0.1',
        WA_BRIDGE_PORT: port,
        WA_BRIDGE_TOKEN: token,
        WA_BRIDGE_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout) child.stdout.resume();
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const line = String(chunk).trim();
        if (line) log.warn('wa-bridge stderr', { message: line });
      });
    }
    bridgeChild = child;

    exitCleanup = () => {
      try {
        child.kill();
      } catch {}
    };
    process.once('exit', exitCleanup);

    let exitError = null;
    child.once('error', (err) => {
      exitError = err;
    });
    child.once('exit', (code, signal) => {
      if (!destroyed && !exitError) {
        exitError = new Error(`wa-bridge exited early (code=${code}, signal=${signal})`);
      }
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitError) {
        await stopSpawnedBridge();
        throw exitError;
      }
      try {
        await refreshHealth();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await stopSpawnedBridge();
    throw exitError || new Error(`wa-bridge did not become healthy within ${timeoutMs}ms`);
  }

  async function stopSpawnedBridge() {
    if (exitCleanup) {
      process.removeListener('exit', exitCleanup);
      exitCleanup = null;
    }
    if (bridgeChild) {
      const child = bridgeChild;
      bridgeChild = null;
      if (child.exitCode == null && child.signalCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve();
          }, 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }

  const transport = {
    [WA_TRANSPORT]: true,
    name: 'whatsmeow',
    get baseUrl() {
      return baseUrl;
    },
    async initialize() {
      if (initialized || destroyed) return;
      initialized = true;
      try {
        await spawnBridgeIfNeeded();
        await refreshHealth();
      } catch (err) {
        initialized = false;
        await stopSpawnedBridge();
        throw err;
      }
      scheduleSseLoop();
    },
    async destroy() {
      destroyed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (sseAbort) {
        sseAbort.abort();
        sseAbort = null;
      }
      await stopSpawnedBridge();
    },
    getSelfWid() {
      return selfWid;
    },
    getSelfLid() {
      return selfLid;
    },
    on(event, handler) {
      let list = listeners.get(event);
      if (!list) {
        list = [];
        listeners.set(event, list);
      }
      list.push(handler);
    },
    async sendText(chatId, text) {
      const data = await apiRequest('POST', '/v1/send/text', { chatId, text });
      return { id: data && typeof data.id === 'string' ? data.id : null };
    },
    async sendPoll(chatId, { name, options, allowMultipleAnswers = false }) {
      const data = await apiRequest('POST', '/v1/send/poll', {
        chatId,
        name,
        options,
        allowMultipleAnswers: Boolean(allowMultipleAnswers),
      });
      return { id: data && typeof data.id === 'string' ? data.id : null };
    },
    async getChat(chatId) {
      const id = typeof chatId === 'string' ? chatId : '';
      if (!id) return null;
      return {
        id,
        isGroup: /@g\.us$/i.test(id),
        isChannel: /@newsletter$/i.test(id),
      };
    },
    async getContact(contactId) {
      if (!contactId) return null;
      try {
        const data = await apiRequest(
          'GET',
          `/v1/contact?id=${encodeURIComponent(String(contactId))}`,
        );
        return normalizeContactPayload(data);
      } catch {
        return null;
      }
    },
    async getChatContact(chat) {
      const id = typeof chat === 'string' ? chat : chat && chat.id;
      if (!id) return null;
      return transport.getContact(id);
    },
    async archiveChat(chat) {
      const chatId = typeof chat === 'string' ? chat : chat && chat.id;
      if (!chatId) throw new Error('chatId is required for archive');
      await apiRequest('POST', '/v1/chat/archive', { chatId, archived: true });
    },
    async muteChat(chat) {
      const chatId = typeof chat === 'string' ? chat : chat && chat.id;
      if (!chatId) return false;
      await apiRequest('POST', '/v1/chat/mute', { chatId, muted: true });
      return true;
    },
    async unmuteChat(chat) {
      const chatId = typeof chat === 'string' ? chat : chat && chat.id;
      if (!chatId) return false;
      await apiRequest('POST', '/v1/chat/mute', { chatId, muted: false });
      return true;
    },
    canBlockContact(contact) {
      return Boolean(contact && contact.id);
    },
    async blockContact(contact) {
      const id = typeof contact === 'string' ? contact : contact && contact.id;
      if (!id) throw new Error('contact.block unavailable');
      await apiRequest('POST', '/v1/contact/block', { id, blocked: true });
    },
    canUnblockContact(contact) {
      return Boolean(contact && contact.id);
    },
    async unblockContact(contact) {
      const id = typeof contact === 'string' ? contact : contact && contact.id;
      if (!id) throw new Error('contact.unblock unavailable');
      await apiRequest('POST', '/v1/contact/block', { id, blocked: false });
    },
    async saveContactName(phone, name) {
      await apiRequest('POST', '/v1/contact/label', { phone, name });
    },
    async deleteContactName(phone) {
      await apiRequest('POST', '/v1/contact/label', { phone, name: '' });
    },
    async resolveLidMappings(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      const data = await apiRequest('POST', '/v1/lid/resolve', { ids: list });
      return Array.isArray(data && data.mappings) ? data.mappings : [];
    },
    async isSelfChatId(chatId) {
      if (!chatId) return false;
      if (selfWid && chatId === selfWid) return true;
      if (selfLid && chatId === selfLid) return true;
      if (!selfWid) return false;
      try {
        const mappings = await transport.resolveLidMappings([selfWid]);
        return mappings.some(
          ({ lid, pn }) =>
            (pn === selfWid && lid === chatId) || (lid === selfWid && pn === chatId),
        );
      } catch {
        return false;
      }
    },
  };

  return transport;
}

module.exports = {
  DEFAULT_BRIDGE_URL,
  isLoopbackHostname,
  validateBridgeBaseUrl,
  parseSseBlock,
  createWhatsmeowTransport,
};
