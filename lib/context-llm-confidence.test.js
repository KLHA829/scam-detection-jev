'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { parseContextReview, applyContextLlmDecision } = require('./context-llm');

const env = { LLM_REVIEW_MIN_CONFIDENCE: '0.7' };

for (const confidence of [true, false, [1], {}, 90, '90', 'high', '0.95', -0.1, '']) {
  it('context-llm rejects confidence ' + JSON.stringify(confidence), () => {
    const review = parseContextReview(JSON.stringify({ action: 'archive', confidence }));
    const decision = { action: 'ignore' };
    assert.equal(applyContextLlmDecision(decision, review, { env }).action, 'ignore');
    assert.equal(review.ok, false);
  });
}

for (const confidence of [null, undefined]) {
  it('context-llm accepts absent confidence ' + String(confidence) + ' without archiving', () => {
    const review = parseContextReview(JSON.stringify({ action: 'archive', confidence }));
    assert.equal(review.ok, true);
    assert.equal(review.confidence, null);
    assert.equal(applyContextLlmDecision({ action: 'ignore' }, review, { env }).action, 'ignore');
  });
}

for (const confidence of [0, 0.95, 1]) {
  it('context-llm accepts confidence ' + confidence, () => {
    const review = parseContextReview(JSON.stringify({ action: 'archive', confidence }));
    assert.equal(review.ok, true);
    assert.equal(review.confidence, confidence);
    assert.equal(
      applyContextLlmDecision({ action: 'ignore' }, review, { env }).action,
      confidence >= 0.7 ? 'archive' : 'ignore',
    );
  });
}

for (const confidence of [NaN, Infinity, -Infinity, true, [1], 90, '90']) {
  it('context-llm rejects injected confidence ' + String(confidence), () => {
    const review = { ok: true, ...{ action: 'archive', confidence } };
    assert.equal(applyContextLlmDecision({ action: 'ignore' }, review, { env }).action, 'ignore');
  });
}
