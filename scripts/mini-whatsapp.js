#!/usr/bin/env node
// @ts-check
'use strict';

require('dotenv/config');

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMiniWhatsApp } = require('../lib/mini-whatsapp');
const { renderMiniWhatsAppHtml } = require('../lib/mini-whatsapp-ui');

function parseArgs(argv) {
  const args = {
    bridgePort: Number(process.env.WA_BRIDGE_PORT || 8767),
    uiPort: Number(process.env.MINI_WA_UI_PORT || 8787),
    token: process.env.WA_BRIDGE_TOKEN || crypto.randomBytes(24).toString('hex'),
    withBot: false,
    withStub: false,
    isolatedEnv: false,
    stateDir: '',
    noUi: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--with-bot') args.withBot = true;
    else if (a === '--with-stub') args.withStub = true;
    else if (a === '--isolated-env') args.isolatedEnv = true;
    else if (a === '--no-ui') args.noUi = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--bridge-port' && i + 1 < argv.length) { args.bridgePort = Number(argv[++i]); }
    else if (a.startsWith('--bridge-port=')) { args.bridgePort = Number(a.slice('--bridge-port='.length)); }
    else if (a === '--ui-port' && i + 1 < argv.length) { args.uiPort = Number(argv[++i]); }
    else if (a.startsWith('--ui-port=')) { args.uiPort = Number(a.slice('--ui-port='.length)); }
    else if (a === '--token' && i + 1 < argv.length) { args.token = argv[++i]; }
    else if (a.startsWith('--token=')) { args.token = a.slice('--token='.length); }
    else if (a === '--state-dir' && i + 1 < argv.length) { args.stateDir = argv[++i]; }
    else if (a.startsWith('--state-dir=')) { args.stateDir = a.slice('--state-dir='.length); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function startMockLlmServer() {
  const srv = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readJson(req);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const sys = msgs.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
    const usr = msgs.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');

    let content;
    if (/Cantonese|廣東話/i.test(sys)) {
      content = JSON.stringify({
        guide: '【Stub AI 提示】模擬檢視到可疑誘導／轉帳風險，請先查證對方身分。',
      });
    } else if (/"label"\s*:/.test(sys)) {
      if (/驗證碼|login|<URL_\d+>/i.test(usr) && !/payme\.hsbc/i.test(usr)) {
        content = JSON.stringify({
          label: 'scam',
          confidence: 0.93,
          signals: ['stub_lure'],
          should_archive: true,
          reason: 'stub_lure',
        });
      } else {
        content = JSON.stringify({
          label: 'not_scam',
          confidence: 0.9,
          signals: [],
          should_archive: false,
          reason: 'stub_benign',
        });
      }
    } else if (/投資|高回報|短炒/i.test(usr)) {
      content = JSON.stringify({ action: 'no_action', pitch: true, strong: false, confidence: 0.9, reason: 'stub_pitch' });
    } else if (/驗證碼|login|<URL_\d+>/i.test(usr) && !/payme\.hsbc/i.test(usr)) {
      content = JSON.stringify({ action: 'archive', pitch: false, strong: true, confidence: 0.93, reason: 'stub_lure' });
    } else {
      content = JSON.stringify({ action: 'no_action', pitch: false, strong: false, confidence: 0.9, reason: 'stub_benign' });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mini-wa-mock-llm',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({ server: srv, url: `http://127.0.0.1:${port}/v1/chat/completions` });
    });
  });
}

function buildBotEnv({
  baseEnv = process.env,
  bridgeUrl,
  token,
  stateDir,
  stubUrl = '',
  mockLlmUrl = '',
  isolatedEnv = false,
}) {
  /** @type {NodeJS.ProcessEnv} */
  const botEnv = {
    ...baseEnv,
    WA_TRANSPORT: 'whatsmeow',
    WA_BRIDGE_AUTO_START: '0',
    WA_BRIDGE_URL: bridgeUrl,
    WA_BRIDGE_TOKEN: token,
    WA_BRIDGE_CURSOR_PATH: path.join(stateDir, 'wa-bridge-cursor.json'),
    OPERATOR_MODE_PATH: path.join(stateDir, 'operator-mode.json'),
    REVIEW_QUEUE_PATH: path.join(stateDir, 'review-queue.json'),
    LLM_REVIEW_COOLDOWN_PATH: path.join(stateDir, 'llm-review-cooldown.json'),
    BOT_CONTACT_NAMES_PATH: path.join(stateDir, 'bot-contact-names.json'),
    USER_RESTORED_CHATS_PATH: path.join(stateDir, 'user-restored-chats.json'),
    BLOCK_LOG_PATH: path.join(stateDir, 'blocks.jsonl'),
    WA_ACTION_GAP_MS: baseEnv.WA_ACTION_GAP_MS || '150',
  };
  if (isolatedEnv) {
    botEnv.OPERATOR_MODE = '';
    botEnv.BLOCK_ENABLED = 'true';
    botEnv.HEURISTIC_ENABLED = 'true';
    botEnv.LLM_REVIEW_ENABLED = '1';
    botEnv.CONTEXT_LLM_ENABLED = '1';
    botEnv.LLM_REVIEW_MIN_CONFIDENCE = '0.7';
    botEnv.MALICIOUS_HOSTS_PATH = path.join(__dirname, '..', 'data', 'malicious-hosts.json');
    if (stubUrl) botEnv.JEVLIKE_API_KEY = '';
  }
  if (stubUrl) {
    botEnv.JEVLIKE_BASE_URL = stubUrl;
  }
  if (mockLlmUrl) {
    botEnv.LLM_REVIEW_API_URL = mockLlmUrl;
    botEnv.LLM_REVIEW_MODEL = 'mini-wa-stub';
    botEnv.LLM_REVIEW_API_KEY = 'stub';
    botEnv.LLM_REVIEW_ENABLED = '1';
    if (isolatedEnv || baseEnv.CONTEXT_LLM_ENABLED === undefined || baseEnv.CONTEXT_LLM_ENABLED === '') {
      botEnv.CONTEXT_LLM_ENABLED = '1';
    }
  }
  return botEnv;
}

function isAllowedLoopbackHost(hostHeader, expectedPort) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  try {
    const parsed = new URL(`http://${hostHeader.trim()}`);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : 80;
    if (expectedPort && port !== Number(expectedPort)) return false;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function isAllowedUiOrigin(originHeader, expectedPort) {
  if (typeof originHeader !== 'string' || !originHeader.trim()) return true;
  try {
    const parsed = new URL(originHeader.trim());
    if (parsed.protocol !== 'http:') return false;
    return isAllowedLoopbackHost(parsed.host, expectedPort);
  } catch {
    return false;
  }
}

async function stopChildProcess(proc) {
  if (!proc || proc.exitCode != null) return;
  const exited = new Promise((resolve) => {
    proc.once('exit', () => resolve());
  });
  try {
    proc.kill();
  } catch {}
  const done = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (!done && proc.exitCode == null) {
    try {
      proc.kill('SIGKILL');
    } catch {}
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'Usage: node scripts/mini-whatsapp.js [options]',
      '  --bridge-port <port>   Loopback wa-bridge port (default: 8767)',
      '  --ui-port <port>       Loopback Web UI port (default: 8787)',
      '  --token <token>        Bearer token for wa-bridge API',
      '  --with-bot             Also spawn whatsapp-bot.js connected to this sandbox',
      '  --with-stub            Also start stub-jevlike + mock OpenAI (for offline UI testing)',
      '  --isolated-env         Ignore .env policy overrides (for clean smoke runs)',
      '  --state-dir <path>     State directory for spawned bot (default: temp dir)',
      '  --no-ui                Run bridge server only without Web UI server',
      '',
    ].join('\n'));
    return;
  }

  const sandbox = createMiniWhatsApp({ port: args.bridgePort, token: args.token });
  await sandbox.start();

  let stubServer = null;
  let mockLlm = null;
  let botProc = null;
  let tempStateDir = '';
  let botStatus = 'external';
  const botLogs = [];
  const uiSseClients = new Set();

  function notifyUiClients() {
    for (const r of [...uiSseClients]) {
      try {
        r.write('event: update\ndata: {}\n\n');
      } catch {
        uiSseClients.delete(r);
      }
    }
  }
  const unsubscribe = sandbox.subscribe(notifyUiClients);

  function pushBotLog(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      botLogs.unshift(line);
      if (botLogs.length > 200) botLogs.length = 200;
      process.stdout.write(`[bot] ${line}\n`);
    }
    notifyUiClients();
  }

  let uiServer = null;
  let uiUrl = '';
  let boundUiPort = args.uiPort;
  if (!args.noUi) {
    const html = renderMiniWhatsAppHtml();
    uiServer = http.createServer(async (req, res) => {
      if (!isAllowedLoopbackHost(req.headers.host, boundUiPort)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'forbidden host' }));
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/ui-stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.flushHeaders();
        uiSseClients.add(res);
        req.on('close', () => uiSseClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sandbox: sandbox.snapshot(), botStatus, botLogs }));
        return;
      }
      if (req.method === 'POST') {
        const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
        if ((fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') || !isAllowedUiOrigin(req.headers.origin, boundUiPort)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'forbidden origin' }));
          return;
        }
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') {
          res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'application/json required' }));
          return;
        }
      }
      try {
        const body = await readJson(req);
        let result = {};
        if (req.method === 'POST' && url.pathname === '/api/inbound') result = sandbox.sendInbound(body);
        else if (req.method === 'POST' && url.pathname === '/api/user') result = sandbox.sendUserMessage(body);
        else if (req.method === 'POST' && url.pathname === '/api/edit') result = sandbox.editMessage(body);
        else if (req.method === 'POST' && url.pathname === '/api/vote') result = sandbox.votePoll(body);
        else if (req.method === 'POST' && url.pathname === '/api/archive') result = sandbox.setChatArchived(body);
        else if (req.method === 'POST' && url.pathname === '/api/contact') result = sandbox.upsertContact(body);
        else if (req.method === 'POST' && url.pathname === '/api/flags') result = sandbox.setStateFlags(body);
        else if (req.method === 'POST' && url.pathname === '/api/reset') {
          sandbox.reset();
          result = { ok: true };
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
      }
    });
    await new Promise((resolve, reject) => {
      uiServer.once('error', reject);
      uiServer.listen(args.uiPort, '127.0.0.1', () => {
        const addr = uiServer.address();
        const port = addr && typeof addr === 'object' ? addr.port : args.uiPort;
        boundUiPort = port;
        uiUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  if (args.withStub) {
    const { startStubServer } = require('../stub-jevlike');
    stubServer = await startStubServer({ port: 0 });
    mockLlm = await startMockLlmServer();
  }

  if (args.withBot) {
    const stateDir = args.stateDir
      ? path.resolve(process.cwd(), args.stateDir)
      : (tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-wa-bot-')));
    fs.mkdirSync(stateDir, { recursive: true });
    let stubUrl = '';
    if (stubServer) {
      const addr = stubServer.address();
      const stubPort = addr && typeof addr === 'object' ? addr.port : 0;
      stubUrl = `http://127.0.0.1:${stubPort}`;
    }
    const botEnv = buildBotEnv({
      baseEnv: process.env,
      bridgeUrl: sandbox.baseUrl,
      token: sandbox.token,
      stateDir,
      stubUrl,
      mockLlmUrl: mockLlm ? mockLlm.url : '',
      isolatedEnv: args.isolatedEnv,
    });
    botStatus = 'running';
    botProc = spawn(process.execPath, [path.join(__dirname, '..', 'whatsapp-bot.js')], {
      cwd: path.join(__dirname, '..'),
      env: botEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    botProc.stdout.on('data', pushBotLog);
    botProc.stderr.on('data', pushBotLog);
    botProc.on('exit', (code) => {
      botStatus = `exited (${code})`;
      notifyUiClients();
    });
  }

  process.stdout.write('\n[Mini-WhatsApp Sandbox Ready]\n');
  if (uiUrl) process.stdout.write(`  Web UI:        ${uiUrl}\n`);
  process.stdout.write(`  wa-bridge URL: ${sandbox.baseUrl}\n`);
  process.stdout.write(`  Bearer Token:  ${sandbox.token}\n`);
  if (!args.withBot) {
    process.stdout.write('\nConnect your real bot (no QR scan needed):\n');
    process.stdout.write(`  WA_TRANSPORT=whatsmeow WA_BRIDGE_AUTO_START=0 WA_BRIDGE_URL=${sandbox.baseUrl} WA_BRIDGE_TOKEN=${sandbox.token} npm start\n\n`);
  }

  const shutdown = async () => {
    unsubscribe();
    await stopChildProcess(botProc);
    if (uiServer) {
      for (const r of [...uiSseClients]) { try { r.end(); } catch {} }
      if (typeof uiServer.closeAllConnections === 'function') uiServer.closeAllConnections();
      await new Promise((resolve) => uiServer.close(() => resolve()));
    }
    if (mockLlm && mockLlm.server) {
      if (typeof mockLlm.server.closeAllConnections === 'function') mockLlm.server.closeAllConnections();
      await new Promise((resolve) => mockLlm.server.close(() => resolve()));
    }
    if (stubServer) {
      if (typeof stubServer.closeAllConnections === 'function') stubServer.closeAllConnections();
      await new Promise((resolve) => stubServer.close(() => resolve()));
    }
    await sandbox.close();
    if (tempStateDir) {
      try {
        fs.rmSync(tempStateDir, { recursive: true, force: true });
      } catch {}
    }
  };

  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  if (process.connected) {
    process.once('disconnect', () => void shutdown().finally(() => process.exit(0)));
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runCli,
  startMockLlmServer,
  buildBotEnv,
  isAllowedLoopbackHost,
  isAllowedUiOrigin,
};
