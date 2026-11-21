'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { measureReceiptLatency } = require('../test/support/receipt-latency');
const { GUIDE_UNAVAILABLE } = require('./review-prompt');

describe('automatic receipt queue isolation', () => {
  for (const options of [
    { maskFails: false },
    { maskFails: true },
    { maskFails: true, archiveFails: true },
  ]) {
    it(`does not hold up another chat archive: ${JSON.stringify(options)}`, async () => {
      const result = await measureReceiptLatency(250, options);
      assert.equal(result.bArchivedWhileMaskPending, true);
      assert.ok(result.archiveLatency < 150, `B archive took ${result.archiveLatency} ms`);
      assert.equal(result.notices.length, 2);
      for (const name of ['A', 'B']) {
        assert.ok(result.events.indexOf(`${name}:archive`) < result.events.indexOf(`${name}:receipt`));
      }
      const a = result.notices.find((text) => text.includes('左邊：Local A'));
      assert.match(a, options.archiveFails ? /^封存未完成/ : /^已封存，未封鎖/);
      assert.ok(a.includes(options.maskFails ? GUIDE_UNAVAILABLE : '唔好撳連結，請用官方電話核實。'));
      assert.equal(result.prompts.length, options.maskFails ? 0 : 2);
      for (const prompt of result.prompts) {
        assert.doesNotMatch(JSON.stringify(prompt), /Local [AB]|85290001111|85290002222/);
      }
    });
  }
});
