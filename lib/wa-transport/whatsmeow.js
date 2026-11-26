// @ts-check
'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WA_TRANSPORT } = require('./wwebjs');
const { readJsonFile, writeJsonFileAtomic } = require('../json-store');
const log = require('../log');

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8767';
const DEFAULT_TIMEOUT_MS = 15000;
const INITIAL_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 5000;
const MAX_HANDLED_SELF_IDS = 2000;

function isLoopbackHostname(hostname) {
  const clean = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (clean === 'localhost' || clean === '::1') return true;
  return net.isIPv4(clean) && clean.startsWith('127.');
}

function validateBridgeBaseUrl(rawUrl, { requireHttp = false } = {}) {
  const input = String(rawUrl || DEFAULT_BRIDGE_URL).trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid WA_BRIDGE_URL: ${input}`);
  }
  if (requireHttp && parsed.protocol !== 'http:') {
    throw new Error(`Auto-started wa-bridge only supports http:// URLs: ${input}`);
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

function allocateLoopbackPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
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

function defaultCursorPath(env = process.env) {
  if (env && env.WA_BRIDGE_CURSOR_PATH) return env.WA_BRIDGE_CURSOR_PATH;
  return path.join(process.cwd(), 'wa-bridge-cursor.json');
}

function createBridgeStateStore(filePath) {
  const cursorsByUrl = new Map();
  const handledSelfIds = new Set();

  function load() {
    if (!filePath) return;
    const res = readJsonFile(filePath);
    if (!res.ok || !res.data || typeof res.data !== 'object') return;
    if (res.data.cursorsByUrl && typeof res.data.cursorsByUrl === 'object') {
      for (const [k, v] of Object.entries(res.data.cursorsByUrl)) {
        if (k && typeof v === 'string' && v) cursorsByUrl.set(k, v);
      }
    }
    if (Array.isArray(res.data.handledSelfIds)) {
      for (const id of res.data.handledSelfIds.slice(-MAX_HANDLED_SELF_IDS)) {
        if (typeof id === 'string' && id) handledSelfIds.add(id);
      }
    }
  }

  function persist() {
    if (!filePath) return;
    try {
      const obj = {};
      for (const [k, v] of cursorsByUrl.entries()) obj[k] = v;
      writeJsonFileAtomic(filePath, {
        cursorsByUrl: obj,
        handledSelfIds: Array.from(handledSelfIds).slice(-MAX_HANDLED_SELF_IDS),
      });
    } catch (err) {
      log.warn('wa-bridge cursor save failed', {
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  load();

  return {
    getCursor(url) {
      return url ? cursorsByUrl.get(url) || '' : '';
    },
    setCursor(url, id) {
      if (!url || !id) return;
      if (cursorsByUrl.get(url) === id) return;
      cursorsByUrl.set(url, id);
      persist();
    },
    hasHandledSelfId(id) {
      return Boolean(id && handledSelfIds.has(id));
    },
    markHandledSelfId(id) {
      if (!id) return;
      if (handledSelfIds.has(id)) return;
      handledSelfIds.add(id);
      while (handledSelfIds.size > MAX_HANDLED_SELF_IDS) {
        const oldest = handledSelfIds.values().next().value;
        handledSelfIds.delete(oldest);
      }
      persist();
    },
  };
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

const BIND_CONFLICT_RE = /bind:|address already in use|only one usage of each socket address/i;

function hasNonEmptyEnv(value) {
  return value != null && String(value).trim() !== '';
}

function resolveAutoStart(options, env) {
  if (options.autoStart !== undefined) {
    return Boolean(options.autoStart);
  }
  const raw = env && env.WA_BRIDGE_AUTO_START != null
    ? String(env.WA_BRIDGE_AUTO_START).trim().toLowerCase()
    : '';
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  const externalConfigured =
    hasNonEmptyEnv(options.baseUrl) ||
    hasNonEmptyEnv(env && env.WA_BRIDGE_URL) ||
    hasNonEmptyEnv(options.token) ||
    hasNonEmptyEnv(env && env.WA_BRIDGE_TOKEN);
  return !externalConfigured;
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
 *   binArgs?: string[],
 *   dbPath?: string,
 *   cursorPath?: string | null,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
function createWhatsmeowTransport(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required for whatsmeow transport');
  }

  const autoStart = resolveAutoStart(options, env);
  const binPath = options.binPath || env.WA_BRIDGE_BIN || defaultBridgeBinaryPath();
  const binArgs = Array.isArray(options.binArgs) ? options.binArgs : [];
  const dbPath = options.dbPath || env.WA_BRIDGE_DB_PATH || path.join(process.cwd(), 'wa-bridge.db');
  const timeoutMs = parseTimeoutMs(options.timeoutMs ?? env.WA_BRIDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const reconnectBaseMs = parseTimeoutMs(options.reconnectBaseMs, INITIAL_RECONNECT_MS);
  const reconnectMaxMs = parseTimeoutMs(options.reconnectMaxMs, MAX_RECONNECT_MS);

  const explicitUrl = hasNonEmptyEnv(options.baseUrl)
    ? String(options.baseUrl).trim()
    : hasNonEmptyEnv(env && env.WA_BRIDGE_URL)
      ? String(env.WA_BRIDGE_URL).trim()
      : '';
  const configuredUrl = autoStart
    ? (explicitUrl ? validateBridgeBaseUrl(explicitUrl, { requireHttp: true }) : '')
    : validateBridgeBaseUrl(explicitUrl || DEFAULT_BRIDGE_URL);
  let baseUrl = configuredUrl;
  const configuredToken = String(options.token ?? env.WA_BRIDGE_TOKEN ?? '').trim();
  const autoRotateToken = autoStart && !configuredToken;
  let token = configuredToken;

  if (!autoStart && !token) {
    throw new Error('WA_BRIDGE_TOKEN is required when connecting to an external wa-bridge');
  }

  const cursorFile =
    options.cursorPath === null
      ? null
      : options.cursorPath !== undefined
        ? options.cursorPath
        : env.WA_BRIDGE_CURSOR_PATH
          ? env.WA_BRIDGE_CURSOR_PATH
          : autoStart
            ? null
            : defaultCursorPath(env);
  const stateStore = createBridgeStateStore(cursorFile);

  /** @type {Map<string, Array<Function>>} */
  const listeners = new Map();
  let selfWid = null;
  let selfLid = null;
  let lastEventId = baseUrl ? stateStore.getCursor(baseUrl) : '';
  let destroyed = false;
  let initialized = false;
  let readyEmitted = false;
  let readyEpoch = null;
  /** @type {AbortController | null} */
  let sseAbort = null;
  /** @type {NodeJS.Timeout | null} */
  let reconnectTimer = null;
  /** @type {import('child_process').ChildProcess | null} */
  let bridgeChild = null;
  let bridgeChildDead = false;
  /** @type {(() => void) | null} */
  let exitCleanup = null;
  /** @type {(() => void) | null} */
  let sigtermCleanup = null;
  /** @type {(() => void) | null} */
  let sigintCleanup = null;

  /** @type {Array<{ id: string, done: boolean }>} */
  const pendingCommits = [];
  /** @type {Map<string, { id: string, done: boolean }>} */
  const uncommittedById = new Map();

  function flushCompletedCursors() {
    while (pendingCommits.length > 0 && pendingCommits[0].done) {
      const finished = pendingCommits.shift();
      if (finished && finished.id) {
        uncommittedById.delete(finished.id);
        lastEventId = finished.id;
        stateStore.setCursor(baseUrl, finished.id);
      }
    }
  }

  function epochOfEventId(id) {
    if (typeof id !== 'string') return '';
    const idx = id.indexOf(':');
    return idx > 0 ? id.slice(0, idx) : '';
  }

  function resetReadiness() {
    readyEmitted = false;
    readyEpoch = null;
  }

  function emitReadyOnce(epoch = '') {
    if (readyEmitted) {
      if (epoch && readyEpoch && epoch !== readyEpoch) {
        readyEpoch = epoch;
        return invokeListeners('ready');
      }
      if (epoch && !readyEpoch) {
        readyEpoch = epoch;
      }
      return Promise.resolve();
    }
    readyEmitted = true;
    readyEpoch = epoch || null;
    return invokeListeners('ready');
  }

  function invokeListeners(event, ...args) {
    const list = listeners.get(event);
    if (!list || list.length === 0) return Promise.resolve();
    const tasks = [];
    for (const fn of [...list]) {
      try {
        tasks.push(Promise.resolve(fn(...args)));
      } catch (err) {
        tasks.push(Promise.reject(err));
      }
    }
    return Promise.allSettled(tasks).then(() => undefined);
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
    return {
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
  }

  function dispatchBridgeEvent(frame) {
    if (frame.id && uncommittedById.has(frame.id)) {
      return;
    }
    const commit = { id: frame.id || '', done: false };
    if (commit.id) {
      pendingCommits.push(commit);
      uncommittedById.set(commit.id, commit);
    }

    const finishCommit = () => {
      commit.done = true;
      flushCompletedCursors();
    };

    const envelope = frame.payload || {};
    const type = envelope.type || frame.event;
    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};

    let work = Promise.resolve();
    if (type === 'qr') {
      resetReadiness();
      if (typeof data.qr === 'string' && data.qr) work = invokeListeners('qr', data.qr);
    } else if (type === 'authenticated') {
      work = invokeListeners('authenticated');
    } else if (type === 'auth_failure') {
      resetReadiness();
      work = invokeListeners('auth_failure', data.reason || 'auth_failure');
    } else if (type === 'ready') {
      if (typeof data.selfWid === 'string' && data.selfWid) selfWid = data.selfWid;
      if (typeof data.selfLid === 'string' && data.selfLid) selfLid = data.selfLid;
      work = emitReadyOnce(epochOfEventId(frame.id));
    } else if (type === 'disconnected') {
      resetReadiness();
      work = invokeListeners('disconnected', data.reason || 'disconnected');
    } else if (type === 'message') {
      work = invokeListeners('message', buildMessageObject(data));
    } else if (type === 'message_create') {
      const msg = buildMessageObject(data);
      if (msg.fromMe && msg.id) {
        if (stateStore.hasHandledSelfId(msg.id)) {
          finishCommit();
          return;
        }
        stateStore.markHandledSelfId(msg.id);
      }
      work = invokeListeners('message_create', msg);
    } else if (type === 'message_edit') {
      const msg = buildMessageObject(data);
      const newBody = typeof data.newBody === 'string' ? data.newBody : msg.body;
      const prevBody = typeof data.prevBody === 'string' ? data.prevBody : null;
      work = invokeListeners('message_edit', msg, newBody, prevBody);
    } else if (type === 'vote_update') {
      work = invokeListeners('vote_update', {
        parentMessageId: typeof data.parentMessageId === 'string' ? data.parentMessageId : null,
        selectedOptions: Array.isArray(data.selectedOptions)
          ? data.selectedOptions.map((s) => String(s)).filter(Boolean)
          : [],
      });
    } else if (type === 'chat_archived') {
      const chatId = typeof data.chatId === 'string' && data.chatId ? data.chatId : null;
      const archived = typeof data.archived === 'boolean' ? data.archived : undefined;
      const wasArchived = typeof data.wasArchived === 'boolean' ? data.wasArchived : undefined;
      if (chatId && typeof archived === 'boolean' && typeof wasArchived === 'boolean') {
        work = invokeListeners(
          'chat_archived',
          {
            id: chatId,
            isGroup: Boolean(data.isGroup),
            isChannel: Boolean(data.isChannel),
          },
          archived,
          wasArchived,
        );
      }
    }

    void work.finally(finishCommit);
  }

  async function openSseStream(signal, handshakeTimeoutMs) {
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    const handshakeAc = new AbortController();
    const onParentAbort = () => handshakeAc.abort();
    if (signal.aborted) handshakeAc.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });

    let timedOut = false;
    const timer =
      handshakeTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            handshakeAc.abort();
          }, handshakeTimeoutMs)
        : null;

    let res;
    try {
      res = await fetchImpl(`${baseUrl}/v1/events`, {
        method: 'GET',
        headers,
        signal: handshakeAc.signal,
      });
    } catch (err) {
      if (timedOut) {
        throw new Error(`wa-bridge SSE handshake timed out after ${handshakeTimeoutMs}ms`, { cause: err });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }

    if (!res.ok) {
      const err = new Error(`wa-bridge SSE HTTP ${res.status}`);
      /** @type {any} */ (err).status = res.status;
      throw err;
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('wa-bridge SSE response has no readable body');
    }
    return { res, abort: () => handshakeAc.abort() };
  }

  async function readSseBody(res) {
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
          if (frame) dispatchBridgeEvent(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const frame = parseSseBlock(buffer);
        if (frame) dispatchBridgeEvent(frame);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  function scheduleSseLoop(initialStream) {
    let delay = reconnectBaseMs;
    let firstStream = initialStream || null;

    const run = async () => {
      while (!destroyed) {
        const ac = new AbortController();
        sseAbort = ac;
        const startedAt = Date.now();
        let streamHandle = firstStream;
        firstStream = null;
        const onAbort = () => {
          if (streamHandle) streamHandle.abort();
        };
        ac.signal.addEventListener('abort', onAbort, { once: true });

        try {
          if (autoStart && bridgeChildDead) {
            await spawnBridgeIfNeeded();
            await refreshHealth();
          }
          if (!streamHandle) {
            streamHandle = await openSseStream(ac.signal, timeoutMs);
          }
          await readSseBody(streamHandle.res);
        } catch (err) {
          if (destroyed) return;
          const status = /** @type {any} */ (err) && /** @type {any} */ (err).status;
          if (status === 401 || status === 403) {
            log.error('wa-bridge authentication rejected', { status });
            void invokeListeners('auth_failure', `wa-bridge HTTP ${status}`);
            return;
          }
          if (!ac.signal.aborted || bridgeChildDead) {
            log.warn('wa-bridge SSE disconnected; retrying', {
              error: err && err.message ? err.message : String(err),
            });
          }
        } finally {
          ac.signal.removeEventListener('abort', onAbort);
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

  /** @type {{ exited: Promise<void>, stderrClosed: Promise<void>, isBindConflict: () => boolean } | null} */
  let lastSpawnMeta = null;
  /** @type {Promise<void> | null} */
  let stopPromise = null;
  /** @type {Promise<void> | null} */
  let signalShutdownPromise = null;

  function detachExitCleanups() {
    if (exitCleanup) {
      process.removeListener('exit', exitCleanup);
      exitCleanup = null;
    }
    if (sigtermCleanup) {
      process.removeListener('SIGTERM', sigtermCleanup);
      sigtermCleanup = null;
    }
    if (sigintCleanup) {
      process.removeListener('SIGINT', sigintCleanup);
      sigintCleanup = null;
    }
  }

  async function stopSpawnedBridge() {
    detachExitCleanups();
    if (stopPromise) return stopPromise;
    if (bridgeChild) {
      const child = bridgeChild;
      bridgeChild = null;
      if (child.pid != null && child.exitCode == null && child.signalCode == null) {
        stopPromise = new Promise((resolve) => {
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
          try {
            child.kill('SIGTERM');
          } catch {}
        }).finally(() => {
          stopPromise = null;
        });
        await stopPromise;
      }
    }
  }

  async function waitForChildBindConflict(waitMs) {
    if (!lastSpawnMeta || configuredUrl || destroyed) return false;
    const meta = lastSpawnMeta;
    const raceTimeout = (promise, ms) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    await raceTimeout(meta.exited, waitMs);
    await raceTimeout(meta.stderrClosed, 50);
    return meta.isBindConflict();
  }

  async function spawnBridgeAttempt() {
    await stopSpawnedBridge();
    bridgeChildDead = false;
    if (autoRotateToken || !token) {
      token = crypto.randomBytes(32).toString('hex');
    }

    let bindHost = '127.0.0.1';
    let port;
    if (configuredUrl) {
      const parsed = new URL(configuredUrl);
      bindHost = parsed.hostname.replace(/^\[|\]$/g, '');
      port = parsed.port || '80';
      baseUrl = configuredUrl;
    } else {
      port = String(await allocateLoopbackPort(bindHost));
      baseUrl = `http://${bindHost}:${port}`;
    }

    const child = spawn(binPath, binArgs, {
      env: {
        ...env,
        WA_BRIDGE_HOST: bindHost,
        WA_BRIDGE_PORT: port,
        WA_BRIDGE_TOKEN: token,
        WA_BRIDGE_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout) child.stdout.resume();
    let stderrTail = '';
    const stderrClosed = child.stderr
      ? new Promise((resolve) => {
          child.stderr.on('data', (chunk) => {
            const text = String(chunk);
            stderrTail = (stderrTail + text).slice(-4096);
            const line = text.trim();
            if (line) log.warn('wa-bridge stderr', { message: line });
          });
          child.stderr.once('close', resolve);
        })
      : Promise.resolve();
    bridgeChild = child;

    exitCleanup = () => {
      try {
        child.kill();
      } catch {}
    };
    const makeSignalCleanup = (signal) => () => {
      detachExitCleanups();
      if (process.listenerCount(signal) === 0) {
        destroyed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (sseAbort) {
          sseAbort.abort();
          sseAbort = null;
        }
        signalShutdownPromise = stopSpawnedBridge().finally(() => {
          process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
        });
      } else {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    };
    sigtermCleanup = makeSignalCleanup('SIGTERM');
    sigintCleanup = makeSignalCleanup('SIGINT');
    process.once('exit', exitCleanup);
    process.once('SIGTERM', sigtermCleanup);
    process.once('SIGINT', sigintCleanup);

    let exitError = null;
    let startupComplete = false;
    let resolveExited;
    const exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    const isBindConflict = () =>
      !configuredUrl && !destroyed && BIND_CONFLICT_RE.test(stderrTail);
    lastSpawnMeta = { exited, stderrClosed, isBindConflict };

    child.once('error', (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      exitError =
        code === 'ENOENT'
          ? new Error(
              `wa-bridge binary not found at ${binPath}. Run "npm run wa-bridge:build" or set WA_TRANSPORT=wwebjs.`,
              { cause: err },
            )
          : err;
      bridgeChildDead = true;
      resetReadiness();
      resolveExited();
      if (startupComplete && !destroyed) {
        log.error('wa-bridge child errored; will restart', { error: err.message });
        if (sseAbort) sseAbort.abort();
        void invokeListeners('disconnected', 'bridge_error');
      }
    });
    child.once('exit', (code, signal) => {
      const intentionalStop = bridgeChild !== child;
      if (bridgeChild === child) bridgeChild = null;
      bridgeChildDead = true;
      resetReadiness();
      if (!destroyed && !exitError) {
        exitError = new Error(`wa-bridge exited early (code=${code}, signal=${signal})`);
      }
      resolveExited();
      if (startupComplete && !destroyed && !intentionalStop) {
        log.error('wa-bridge child exited unexpectedly; will restart', { code, signal });
        if (sseAbort) sseAbort.abort();
        void invokeListeners('disconnected', 'bridge_exited');
      }
    });

    const buildExitError = async (err) => {
      await Promise.race([stderrClosed, new Promise((resolve) => setTimeout(resolve, 50))]);
      await stopSpawnedBridge();
      return Object.assign(err, { bindConflict: isBindConflict() });
    };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitError) {
        throw await buildExitError(exitError);
      }
      try {
        await refreshHealth();
        if (exitError) {
          throw await buildExitError(exitError);
        }
        if (bridgeChildDead) {
          throw await buildExitError(new Error('wa-bridge exited during startup'));
        }
        startupComplete = true;
        return;
      } catch (err) {
        if (err && /** @type {any} */ (err).bindConflict !== undefined) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (exitError) {
      throw await buildExitError(exitError);
    }
    await stopSpawnedBridge();
    throw new Error(`wa-bridge did not become healthy within ${timeoutMs}ms`);
  }

  async function spawnBridgeIfNeeded() {
    if (!autoStart) return;
    const maxAttempts = configuredUrl ? 1 : 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await spawnBridgeAttempt();
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts && err && /** @type {any} */ (err).bindConflict && !destroyed) {
          log.warn('wa-bridge ephemeral port bind conflict; retrying', {
            attempt,
            error: /** @type {any} */ (err).message,
          });
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async function connectInitialBridgeAndSse() {
    const maxAttempts = autoStart && !configuredUrl ? 3 : 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (autoStart) await spawnBridgeAttempt();
        const health = await refreshHealth();
        const ac = new AbortController();
        sseAbort = ac;
        const initialStream = await openSseStream(ac.signal, timeoutMs);
        return { health, initialStream };
      } catch (err) {
        lastErr = err;
        if (sseAbort) {
          sseAbort.abort();
          sseAbort = null;
        }
        const retryable =
          attempt < maxAttempts &&
          autoStart &&
          !configuredUrl &&
          !destroyed &&
          (Boolean(/** @type {any} */ (err)?.bindConflict) || (await waitForChildBindConflict(timeoutMs)));
        await stopSpawnedBridge();
        if (retryable) {
          log.warn('wa-bridge ephemeral port bind conflict; retrying', {
            attempt,
            error: /** @type {any} */ (err).message,
          });
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
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
      let initialStream;
      let health;
      try {
        ({ health, initialStream } = await connectInitialBridgeAndSse());
      } catch (err) {
        initialized = false;
        if (sseAbort) {
          sseAbort.abort();
          sseAbort = null;
        }
        await stopSpawnedBridge();
        if (signalShutdownPromise) {
          await signalShutdownPromise;
          return;
        }
        throw err;
      }
      scheduleSseLoop(initialStream);
      if (health && (health.state === 'ready' || (health.connected && health.loggedIn))) {
        void emitReadyOnce();
      }
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
      await apiRequest('DELETE', '/v1/contact/label', { phone });
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
