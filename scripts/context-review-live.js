#!/usr/bin/env node
'use strict';

/**
 * Live context-review benchmark through the real processIncomingMessage of a checkout, with the
 * offline stub mask and the chat API from LLM_REVIEW_* env. Every row comes from an unsaved
 * sender in automatic mode. Earlier `context` turns are replayed first: the sender's through
 * recentContext, the user's own through recordOutgoingMessage when the checkout has it (a
 * checkout without it never sees them, as the live bot does not).
 *
 *   node scripts/context-review-live.js [checkout] [--set legit|threads|scam|all] [--out file.json]
 *
 * Rows always come from this script's checkout, so a `git worktree` of main runs the same rows.
 *
 * The mask is the offline regex stub, not the live `/v1/mask` worker the bot requires. Only run
 * this on the synthetic fixture rows, never on real chats.
 */

const fs = require('fs');
const path = require('path');

const here = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : here);
const SET = flag('set', 'all');
const OUT = flag('out', null);
const CONCURRENCY = Number(flag('concurrency', '4'));

const log = require(path.join(root, 'lib/log'));
const handler = require(path.join(root, 'lib/handle-incoming'));
const { createRecentContext } = require(path.join(root, 'lib/context-llm'));
const { createStubJevlikeClient } = require(path.join(root, 'stub-jevlike'));

function loadRows() {
  const sets = [];
  if (SET === 'all' || SET === 'legit') {
    const legit = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/legit-messages.json'), 'utf8'));
    sets.push(...legit.messages.map((m) => ({ ...m, set: m.category === 'merchant' ? 'merchant' : 'legit', scam: false })));
  }
  if (SET === 'all' || SET === 'threads') {
    const threads = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/context-scam-threads.json'), 'utf8'));
    sets.push(...threads.messages.map((m) => ({ ...m, set: 'threads', scam: true })));
  }
  if (SET === 'all' || SET === 'scam') {
    const file = path.join(here, 'data/corpus/normalized/vanila434_elder_safety.jsonl');
    const seen = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.label !== 'scam' || seen.has(row.text)) continue;
      seen.add(row.text);
      sets.push({ id: row.id, body: row.text, set: 'scam', scam: true });
    }
  }
  return sets;
}

async function runRow(row) {
  const chatId = `${row.id}@c.us`;
  const recentContext = createRecentContext();
  const deps = {
    env: { ...process.env, LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
    operatorMode: 'auto',
    maskClient: createStubJevlikeClient(),
    recentContext,
    llmReview: { enabled: true },
    resolveNumber: async () => ({ digits: '85261234567', unresolvedLid: false }),
    blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
    labelContact: async () => ({ labelled: true }),
    archiveChat: async () => {},
    recordBlock: async () => {},
  };
  for (const turn of row.context || []) {
    if (!turn.fromMe) recentContext.push(chatId, turn.body);
    else if (handler.recordOutgoingMessage) {
      handler.recordOutgoingMessage({ type: 'chat', chatId, body: turn.body }, deps);
    }
  }
  for (let attempt = 0; ; attempt += 1) {
    const out = await handler.processIncomingMessage(
      { type: 'chat', body: row.body, chatId, savedContact: false },
      deps,
    );
    const review = out.llmReview || {};
    if (review.ok === false && /http_error|timeout|llm_error/.test(review.reason) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const action = out.blocked ? 'block' : out.archived ? 'archive' : out.labelled ? 'label' : 'ignore';
    const verdict = review.ok && (review.action === 'archive' || review.action === 'block') && review.confidence >= 0.7;
    return {
      id: row.id,
      held: verdict && action !== 'archive' && action !== 'block',
      set: row.set,
      scam: row.scam,
      action,
      rule: out.decision.archiveReason || out.decision.blockReason || out.decision.labelReason || null,
      model: review.ok ? `${review.action} ${review.confidence}` : `failed ${review.reason || 'none'}`,
      reason: review.reason || '',
      transcript: out.redacted || null,
    };
  }
}

async function main() {
  for (const level of ['scan', 'info', 'ok', 'warn']) log[level] = () => {};
  const rows = loadRows();
  const results = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < rows.length) {
      const i = next++;
      results[i] = await runRow(rows[i]);
    }
  }));

  console.log(`checkout ${root}  model ${process.env.LLM_REVIEW_MODEL || '(default)'}`);
  console.log('| set | rows | archived or blocked | held for the next message | labelled （可疑推銷） | review failed |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const set of ['legit', 'merchant', 'threads', 'scam']) {
    const runs = results.filter((r) => r.set === set);
    if (!runs.length) continue;
    const flagged = runs.filter((r) => r.action === 'archive' || r.action === 'block').length;
    const held = runs.filter((r) => r.held).length;
    console.log(`| ${set} | ${runs.length} | ${flagged} | ${held} | ${runs.filter((r) => r.action === 'label').length} | ${runs.filter((r) => r.model.startsWith('failed')).length} |`);
  }
  const wrong = results.filter((r) => (r.action === 'archive' || r.action === 'block') !== r.scam);
  console.log(`\nfalse archives and scams not archived (${wrong.length}):`);
  for (const r of wrong) console.log(`- ${r.set} ${r.id} -> ${r.action} (${r.model}) ${r.reason}`);
  if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(results, null, 1)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
