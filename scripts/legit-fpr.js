#!/usr/bin/env node
'use strict';

/**
 * False block / false archive rate on fixtures/legit-messages.json, through the real
 * processIncomingMessage with production defaults and a model that always answers not_scam.
 *
 *   node scripts/legit-fpr.js                    # report
 *   node scripts/legit-fpr.js --update-baseline  # rewrite fixtures/legit-fpr-baseline.json
 */

const fs = require('fs');

const {
  BASELINE_PATH,
  runLegitBenchmark,
  falsePositives,
  summarize,
} = require('../test/support/legit-fpr');

async function main() {
  const results = await runLegitBenchmark();
  const found = falsePositives(results);
  const bodies = new Map(results.map((r) => [r.message.id, r.message]));

  console.log('| contact | runs | false block | false archive (counts blocks) | alert instead of automatic action | reached masked LLM |');
  console.log('|---|---|---|---|---|---|');
  for (const row of summarize(results)) {
    console.log(`| ${row.contact} | ${row.messages} | ${row.blocked} | ${row.archived} | ${row.deferred} | ${row.reachedLlm} |`);
  }
  console.log(`\nfalse positives (${found.length}):`);
  for (const fp of found) {
    const m = bodies.get(fp.id);
    const fwd = m.forwarded ? ' forwarded' : '';
    console.log(`- ${fp.id} ${fp.contact}${fwd} -> ${fp.action} (${fp.rule}): ${m.body.replace(/\s+/g, ' ')}`);
  }

  if (process.argv.includes('--update-baseline')) {
    const lines = found.map((fp) => `  ${JSON.stringify(fp)}`).join(',\n');
    fs.writeFileSync(BASELINE_PATH, `{\n "falsePositives": [\n${lines}\n ]\n}\n`);
    console.log(`\nwrote ${BASELINE_PATH}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
