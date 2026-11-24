'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyXxx, mergeSpans } = require('./pii-xxx');

describe('pii-xxx out-of-range and overlapping spans', () => {
  it('ignores out-of-range and inverted spans before merging valid overlaps', () => {
    assert.equal(
      applyXxx('abc', [
        { start: -5, end: 2 },
        { start: 1, end: 100 },
        { start: 2, end: 1 },
        { start: 1, end: 2 },
      ]),
      'aXXXc',
    );
    assert.equal(
      applyXxx('abc', [
        { start: -5, end: -1 },
        { start: 10, end: 20 },
        { start: 1, end: 2 },
      ]),
      'aXXXc',
    );
  });

  it('merges overlapping spans and preserves custom replacement', () => {
    assert.deepEqual(
      mergeSpans([
        { start: 3, end: 8 },
        { start: 6, end: 10, replacement: ' XXX' },
      ]),
      [{ start: 3, end: 10, label: 'pii', replacement: ' XXX' }],
    );
    assert.equal(
      applyXxx('go https://evil.example/secret?x=1', [
        { start: 23, end: 34, replacement: ' XXX' },
      ]),
      'go https://evil.example XXX',
    );
  });
});
