#!/usr/bin/env node
// @ts-check
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * @param {() => any} fn
 * @param {string} label
 * @param {{ timeoutMs?: number, intervalMs?: number, getLogs?: () => string }} [options]
 */
async function waitUntil(fn, label, options = {}) {
  const { timeoutMs = 15000, intervalMs = 100, getLogs } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const extra = typeof getLogs === 'function' ? `\n${getLogs()}` : '';
  throw new Error(`Timed out waiting for ${label}${extra}`);
}

async function main() {
  const cliPath = path.join(__dirname, 'mini-whatsapp.js');
  const proc = spawn(
    process.execPath,
    [cliPath, '--bridge-port', '0', '--ui-port', '0', '--with-bot', '--with-stub', '--isolated-env'],
    {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );

  let logs = '';
  proc.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  const getLogs = () => `--- mini-wa output ---\n${logs}`;

  try {
    const uiUrl = await waitUntil(
      () => {
        const match = logs.match(/Web UI:\s+(http:\/\/127\.0\.0\.1:\d+)/);
        return match ? match[1] : null;
      },
      'Web UI URL',
      { getLogs },
    );

    const home = await fetch(uiUrl);
    if (home.status !== 200) {
      throw new Error(`Unexpected Web UI status ${home.status}`);
    }
    const html = await home.text();
    if (!html.includes('Mini WhatsApp Sandbox')) {
      throw new Error('Web UI HTML missing expected title');
    }

    const initial = await waitUntil(
      async () => {
        const res = await fetch(`${uiUrl}/api/state`);
        if (!res.ok) return null;
        const json = await res.json();
        const actions = (json.sandbox && json.sandbox.actions) || [];
        const poll = actions.find((a) => a.op === 'sendPoll');
        if (json.botStatus === 'running' && json.sandbox.sseClientsCount === 1 && poll) {
          return { poll };
        }
        return null;
      },
      'bot SSE connection and setup poll',
      { getLogs },
    );

    const voteRes = await fetch(`${uiUrl}/api/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pollId: initial.poll.id,
        selectedOptions: ['自動封鎖同封存'],
      }),
    });
    if (!voteRes.ok) {
      throw new Error(`Setup poll vote failed: HTTP ${voteRes.status}`);
    }

    const inboundRes = await fetch(`${uiUrl}/api/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: '85261110001@c.us',
        body: 'Please verify at http://malicious-block-test.invalid',
      }),
    });
    if (!inboundRes.ok) {
      throw new Error(`Inbound message injection failed: HTTP ${inboundRes.status}`);
    }

    const verified = await waitUntil(
      async () => {
        const res = await fetch(`${uiUrl}/api/state`);
        if (!res.ok) return null;
        const json = await res.json();
        const actions = (json.sandbox && json.sandbox.actions) || [];
        const blocked = actions.find(
          (a) => a.op === 'blockContact' && a.id === '85261110001@c.us',
        );
        const unblockPoll = actions.find(
          (a) => a.op === 'sendPoll' && typeof a.name === 'string' && a.name.includes('解除封鎖'),
        );
        if (blocked && unblockPoll) {
          return {
            uiUrl,
            botStatus: json.botStatus,
            sseClientsCount: json.sandbox.sseClientsCount,
            actionsCount: actions.length,
          };
        }
        return null;
      },
      'malicious-host blockContact + Self-Chat unblock poll',
      { getLogs },
    );

    process.stdout.write(`mini-wa smoke ok: ${JSON.stringify(verified)}\n`);
  } finally {
    const exitPromise = new Promise((resolve) => {
      if (proc.exitCode != null) resolve(proc.exitCode);
      else proc.once('exit', (code) => resolve(code));
    });
    if (proc.connected) proc.disconnect();
    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!exited && proc.exitCode == null) {
      proc.kill();
      await exitPromise;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
