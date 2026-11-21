'use strict';

const assert = require('node:assert/strict');
const { measureGuidedLatency } = require('../test/support/guided-latency');

async function main() {
  console.log('Stage | delay (ms) | runs | B archive median (ms) | total median (ms) | chats/s median');
  for (const stage of ['mask', 'llm']) {
    for (const delay of [0, 250, 1000]) {
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = await measureGuidedLatency(delay, { stage });
        assert.ok(Number.isFinite(result.archiveLatency));
        assert.ok(result.events.includes('poll'));
        results.push(result);
      }
      const median = (key) => results.map((result) => result[key]).sort((a, b) => a - b)[2].toFixed(2);
      console.log(`${stage} | ${delay} | 5 | ${median('archiveLatency')} | ${median('totalMs')} | ${median('throughput')}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
