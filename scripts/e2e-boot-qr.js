// @ts-check
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { startStubServer } = require('../stub-jevlike');
const { buildWaBridge, defaultBinaryName } = require('./build-wa-bridge');

const ROOT = path.join(__dirname, '..');
const QR_MARKER = 'scan QR to link WhatsApp Web';
const SUPPORTED_TRANSPORTS = new Set(['wwebjs', 'whatsmeow']);

function parseTransportArg(argv = process.argv.slice(2), env = process.env) {
  let raw = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--transport' && i + 1 < argv.length) {
      raw = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--transport=')) {
      raw = arg.slice('--transport='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const value = String(raw || env.BOOT_QR_TRANSPORT || 'wwebjs')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_TRANSPORTS.has(value)) {
    throw new Error(`Unsupported boot smoke transport "${value}" (expected wwebjs or whatsmeow)`);
  }
  return value;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('local test server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createMockServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'boot-mock-openai' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const requestEnded = once(req, 'end');
    req.resume();
    await requestEnded;
    const content = JSON.stringify({
      action: 'no_action',
      confidence: 0.9,
      reason: 'boot smoke idle response',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-boot-smoke',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });
}

function watchForQr(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    let lineBuffer = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onOutput);
      child.stderr?.removeListener('data', onOutput);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onOutput = (chunk) => {
      const text = String(chunk);
      output = (output + text).slice(-20000);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (/^\[(INFO|OK|WARN|ERROR|SCAN)\]/.test(line)) {
          process.stdout.write(`[bot] ${line}\n`);
        }
      }
      if (output.includes(QR_MARKER)) finish();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) =>
      finish(
        new Error(
          `bot exited before QR (code=${code}, signal=${signal}); output tail:\n${output.slice(-2000)}`,
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `QR marker not seen within ${timeoutMs}ms; output tail:\n${output.slice(-2000)}`,
          ),
        ),
      timeoutMs,
    );

    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function signalBot(child, signal) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

function stopWin32Tree(pid) {
  if (!pid) return false;
  const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  return res.status === 0;
}

async function stopBot(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32' && child.pid) {
    if (!stopWin32Tree(child.pid)) {
      signalBot(child, 'SIGKILL');
    }
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    return;
  }
  signalBot(child, 'SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!stopped && child.exitCode == null && child.signalCode == null) {
    signalBot(child, 'SIGKILL');
    await exited;
  }
}

async function main() {
  const transport = parseTransportArg();
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scam-detection-boot-qr-'),
  );
  let maskServer = null;
  let mockServer = null;
  let bot = null;

  try {
    let bridgeBin = '';
    if (transport === 'whatsmeow') {
      const rawConfigured = process.env.WA_BRIDGE_BIN ? String(process.env.WA_BRIDGE_BIN).trim() : '';
      const configuredBin = rawConfigured ? path.resolve(process.cwd(), rawConfigured) : '';
      if (configuredBin && fs.existsSync(configuredBin)) {
        bridgeBin = configuredBin;
      } else {
        process.stdout.write('[boot] building wa-bridge for whatsmeow boot smoke\n');
        bridgeBin = buildWaBridge({
          outPath: path.join(runtimeDir, defaultBinaryName()),
          cwd: runtimeDir,
          quiet: false,
        });
      }
    }

    maskServer = await startStubServer({ port: 0 });
    const maskAddress = maskServer.address();
    if (!maskAddress || typeof maskAddress === 'string') {
      throw new Error('mask stub did not bind to a TCP port');
    }
    const llmPort = await listen((mockServer = createMockServer()));
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      WA_TRANSPORT: transport,
      JEVLIKE_BASE_URL: `http://127.0.0.1:${maskAddress.port}`,
      JEVLIKE_TIMEOUT_MS: '1000',
      LLM_REVIEW_API_URL: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
      LLM_REVIEW_MODEL: 'boot-mock-openai',
      LLM_REVIEW_API_KEY: 'dummy',
      LLM_REVIEW_ENABLED: 'true',
      LLM_REVIEW_COOLDOWN_MS: '0',
      LLM_REVIEW_COOLDOWN_PATH: path.join(runtimeDir, 'llm-review-cooldown.json'),
      PUPPETEER_NO_SANDBOX: '1',
      OPERATOR_MODE: 'auto',
      OPERATOR_MODE_PATH: path.join(runtimeDir, 'operator-mode.json'),
      REVIEW_QUEUE_PATH: path.join(runtimeDir, 'review-queue.json'),
      BLOCK_LOG_PATH: path.join(runtimeDir, 'blocks.jsonl'),
      WA_ACTION_GAP_MS: '0',
    };
    if (transport === 'whatsmeow') {
      delete env.WA_BRIDGE_URL;
      delete env.WA_BRIDGE_TOKEN;
      env.WA_BRIDGE_AUTO_START = '1';
      env.WA_BRIDGE_BIN = bridgeBin;
      env.WA_BRIDGE_DB_PATH = path.join(runtimeDir, 'wa-bridge.db');
      env.WA_BRIDGE_CURSOR_PATH = path.join(runtimeDir, 'wa-bridge-cursor.json');
    }
    const timeoutMs = Number(process.env.BOOT_QR_TIMEOUT_MS) || 120000;
    const startedAt = Date.now();
    bot = spawn(process.execPath, [path.join(ROOT, 'whatsapp-bot.js')], {
      cwd: runtimeDir,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(`[boot] transport=${transport} bot pid=${bot.pid || 'unknown'}\n`);

    await watchForQr(bot, timeoutMs);
    process.stdout.write(
      `E2E boot-to-QR (${transport}) passed in ${Date.now() - startedAt}ms; QR was not scanned\n`,
    );
  } finally {
    await stopBot(bot);
    await closeServer(mockServer);
    await closeServer(maskServer);
    fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
