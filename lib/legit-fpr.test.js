'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  loadLegitMessages,
  loadBaseline,
  runLegitBenchmark,
  falsePositives,
} = require('../test/support/legit-fpr');

describe('legit-message false positive benchmark', () => {
  it('has a few hundred unique legit messages across categories and languages', () => {
    const messages = loadLegitMessages();
    assert.ok(messages.length >= 300, `${messages.length} messages`);
    assert.equal(new Set(messages.map((m) => m.id)).size, messages.length);
    for (const lang of ['yue', 'zh-Hant', 'zh-Hans', 'en', 'mixed']) {
      assert.ok(messages.some((m) => m.lang === lang), lang);
    }
    for (const category of ['family', 'bank', 'delivery', 'clinic', 'gov', 'warning']) {
      assert.ok(messages.some((m) => m.category === category), category);
    }
  });

  it('archives or blocks exactly the known false positives in the baseline', async () => {
    const found = falsePositives(await runLegitBenchmark());
    assert.deepEqual(
      found,
      loadBaseline(),
      'Legit-message false positives changed. Run `node scripts/legit-fpr.js` to see them; ' +
        'if the change is intended, rerun it with --update-baseline and commit the baseline.',
    );
  });
});
