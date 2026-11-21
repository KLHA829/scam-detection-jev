'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLlmReview, mergeLlmDecision } = require('./llm-review');

for (const confidence of [true, false, [1], {}, 90, '90', 'high', '0.95', -0.1, '']) {
  it('llm-review rejects confidence ' + JSON.stringify(confidence), () => {
    const review = parseLlmReview(JSON.stringify({ label: 'scam', should_archive: true, confidence }));
    const decision = { action: 'ignore' };
    assert.equal(mergeLlmDecision(decision, review).action, 'ignore');
    assert.equal(review.ok, false);
  });
}

for (const confidence of [null, undefined]) {
  it('llm-review accepts absent confidence ' + String(confidence) + ' without archiving', () => {
    const review = parseLlmReview(JSON.stringify({ label: 'scam', should_archive: true, confidence }));
    assert.equal(review.ok, true);
    assert.equal(review.confidence, null);
    assert.equal(mergeLlmDecision({ action: 'ignore' }, review).action, 'ignore');
  });
}

for (const confidence of [0, 0.95, 1]) {
  it('llm-review accepts confidence ' + confidence, () => {
    const review = parseLlmReview(JSON.stringify({ label: 'scam', should_archive: true, confidence }));
    assert.equal(review.ok, true);
    assert.equal(review.confidence, confidence);
    assert.equal(
      mergeLlmDecision({ action: 'ignore' }, review).action,
      confidence >= 0.7 ? 'archive' : 'ignore',
    );
  });
}

for (const confidence of [NaN, Infinity, -Infinity, true, [1], 90, '90']) {
  it('llm-review rejects injected confidence ' + String(confidence), () => {
    const review = { ok: true, ...{ label: 'scam', should_archive: true, confidence } };
    assert.equal(mergeLlmDecision({ action: 'ignore' }, review).action, 'ignore');
  });
}
