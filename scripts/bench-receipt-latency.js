'use strict';

const assert = require('node:assert/strict');
const { measureReceiptLatency } = require('../test/support/receipt-latency');

async function main() {
  console.log('A mask delay (ms) | runs | B archive median (ms)');
  for (const delay of [0, 250, 1000]) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const result = await measureReceiptLatency(delay);
      assert.equal(result.notices.length, 2);
      assert.ok(Number.isFinite(result.archiveLatency));
      times.push(result.archiveLatency);
    }
    times.sort((a, b) => a - b);
    console.log(`${delay} | ${times.length} | ${times[2].toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
