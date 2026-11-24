#!/usr/bin/env node
'use strict';

/**
 * Masking work of the context review through the real processIncomingMessage of a checkout and
 * the live `/v1/mask` worker (JEVLIKE_BASE_URL, default http://127.0.0.1:8766). The legit
 * fixture bodies (`--set legit`, default) or the scam corpus (`--set scam`) are replayed as 16
 * chats of 20 turns; every fourth turn is the user's own. The chat API is a local mock answering
 * no_action, so every inbound turn outside the blocklist fast path is reviewed.
 *
 *   node scripts/bench-context-mask.js [checkout] [--set legit|scam] [--out transcripts.json]
 *
 * Rows always come from this script's checkout, so a `git worktree` of main runs the same rows.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const here = path.join(__dirname, '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? args[outAt + 1] : null;
const setAt = args.indexOf('--set');
const SET = setAt >= 0 ? args[setAt + 1] : 'legit';
const root = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : here);

const log = require(path.join(root, 'lib/log'));
const handler = require(path.join(root, 'lib/handle-incoming'));
const { createRecentContext } = require(path.join(root, 'lib/context-llm'));
const { createMaskClient } = require(path.join(root, 'lib/jevlike-client'));

const CHATS = 16;
const TURNS = 20;

function loadBodies() {
  if (SET === 'scam') {
    const file = path.join(here, 'data/corpus/normalized/vanila434_elder_safety.jsonl');
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    return [...new Set(rows.filter((row) => row.label === 'scam').map((row) => row.text))];
  }
  return JSON.parse(fs.readFileSync(path.join(here, 'fixtures/legit-messages.json'), 'utf8')).messages.map(({ body }) => body);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
  for (const level of ['scan', 'info', 'ok', 'warn']) log[level] = () => {};
  const bodies = loadBodies();
  const live = createMaskClient(process.env);
  const stats = { calls: 0, rows: 0, maskMs: 0 };
  const maskClient = {
    async maskMessages(list) {
      const start = process.hrtime.bigint();
      try {
        return await live.maskMessages(list);
      } finally {
        stats.calls += 1;
        stats.rows += list.length;
        stats.maskMs += Number(process.hrtime.bigint() - start) / 1e6;
      }
    },
  };
  const transcripts = [];
  const perMessageMs = [];
  const recentContext = createRecentContext();
  const deps = {
    env: { ...process.env, LLM_REVIEW_COOLDOWN_MS: '0' },
    operatorMode: 'auto',
    maskClient,
    recentContext,
    llmReview: {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      async fetchImpl(url, init) {
        transcripts.push(JSON.parse(init.body).messages.at(-1).content);
        const content = JSON.stringify({ action: 'no_action', pitch: false, strong: false, confidence: 0.9, reason: 'bench' });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      },
    },
    resolveNumber: async () => ({ digits: '85261234567', unresolvedLid: false }),
    archiveChat: async () => {},
    blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
    labelContact: async () => ({ labelled: true }),
    recordBlock: async () => {},
  };
  let inbound = 0;
  let acted = 0;
  for (let chat = 0; chat < CHATS; chat += 1) {
    const chatId = `8526000${String(chat).padStart(4, '0')}@c.us`;
    for (let turn = 0; turn < TURNS; turn += 1) {
      const body = bodies[(chat * TURNS + turn) % bodies.length];
      const messageId = `bench-${chat}-${turn}`;
      if (turn % 4 === 3) {
        handler.recordOutgoingMessage({ type: 'chat', chatId, body, messageId }, deps);
        continue;
      }
      const before = stats.maskMs;
      const out = await handler.processIncomingMessage({ type: 'chat', body, chatId, savedContact: false, messageId }, deps);
      if (out.archived || out.blocked) acted += 1;
      perMessageMs.push(stats.maskMs - before);
      inbound += 1;
    }
  }
  perMessageMs.sort((a, b) => a - b);
  const digest = crypto.createHash('sha256').update(transcripts.join('\n\u0000\n')).digest('hex').slice(0, 16);
  console.log(`checkout ${root}  set ${SET}`);
  console.log('| inbound messages | archived or blocked | reviews sent | /v1/mask calls | rows masked | mask time total (s) | mask ms per message p50 / p90 | transcripts sha256 |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|---|');
  console.log(`| ${inbound} | ${acted} | ${transcripts.length} | ${stats.calls} | ${stats.rows} | ${(stats.maskMs / 1000).toFixed(1)} | ${percentile(perMessageMs, 0.5).toFixed(0)} / ${percentile(perMessageMs, 0.9).toFixed(0)} | ${digest} |`);
  if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(transcripts, null, 1)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
