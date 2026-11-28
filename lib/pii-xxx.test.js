'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyXxx, mergeSpans, classifyPiiText, createMaskTypingState } = require('./pii-xxx');

describe('pii-xxx out-of-range and overlapping spans', () => {
  it('ignores out-of-range and inverted spans before merging valid overlaps', () => {
    assert.equal(
      applyXxx('abc', [
        { start: -5, end: 2 },
        { start: 1, end: 100 },
        { start: 2, end: 1 },
        { start: 1, end: 2 },
      ]),
      'a<PII_1>c',
    );
    assert.equal(
      applyXxx('abc', [
        { start: -5, end: -1 },
        { start: 10, end: 20 },
        { start: 1, end: 2 },
      ]),
      'a<PII_1>c',
    );
  });

  it('merges overlapping spans and preserves custom replacement', () => {
    assert.deepEqual(
      mergeSpans([
        { start: 3, end: 8 },
        { start: 6, end: 10, replacement: ' <PII>' },
      ]),
      [{ start: 3, end: 10, label: 'pii', replacement: ' <PII>' }],
    );
    assert.equal(
      applyXxx('go https://evil.example/secret?x=1', [
        { start: 23, end: 34, replacement: ' <PII>' },
      ]),
      'go https://evil.example <URL_1>',
    );
  });
});

describe('classifyPiiText', () => {
  it('classifies by shape', () => {
    assert.equal(classifyPiiText('91234567'), 'PHONE');
    assert.equal(classifyPiiText('+852 9123 4567'), 'PHONE');
    assert.equal(classifyPiiText('6222 0202 0202 0888'), 'ACCOUNT');
    assert.equal(classifyPiiText('chan@gmail.com'), 'EMAIL');
    assert.equal(classifyPiiText('https://evil.example/x'), 'URL');
    assert.equal(classifyPiiText('evil.example/login'), 'URL');
    assert.equal(classifyPiiText('A123456(7)'), 'ID');
    assert.equal(classifyPiiText('陳大文'), 'NAME');
    assert.equal(classifyPiiText('Chan Tai Man'), 'NAME');
    assert.equal(classifyPiiText('旺角中心'), 'NAME');
    assert.equal(classifyPiiText('something else entirely'), 'PII');
  });
});

describe('typed placeholders', () => {
  it('types spans and numbers repeated types in reading order', () => {
    const out = applyXxx('call 91234567 or 98765432 now', [
      { start: 5, end: 13 },
      { start: 17, end: 25 },
    ]);
    assert.equal(out, 'call <PHONE_1> or <PHONE_2> now');
  });

  it('reuses one token for the same underlying text', () => {
    const out = applyXxx('91234567 again 91234567', [
      { start: 0, end: 8 },
      { start: 15, end: 23 },
    ]);
    assert.equal(out, '<PHONE_1> again <PHONE_1>');
  });

  it('shares numbering across messages when given one state', () => {
    const state = createMaskTypingState();
    const first = applyXxx('91234567', [{ start: 0, end: 8 }], state);
    const second = applyXxx('98765432 then 91234567', [
      { start: 0, end: 8 },
      { start: 14, end: 22 },
    ], state);
    assert.equal(first, '<PHONE_1>');
    assert.equal(second, '<PHONE_2> then <PHONE_1>');
  });

  it('numbers typed tokens inside replacement templates', () => {
    assert.equal(
      applyXxx('aa bb', [
        { start: 0, end: 2, replacement: '<PII>' },
        { start: 3, end: 5, replacement: '<PII>' },
      ]),
      '<PII_1> <PII_2>',
    );
    assert.equal(
      applyXxx('aa aa', [
        { start: 0, end: 2, replacement: '<PII>' },
        { start: 3, end: 5, replacement: '<PII>' },
      ]),
      '<PII_1> <PII_1>',
    );
  });

  it('never leaks the masked characters into the token', () => {
    const secret = '91234567';
    const out = applyXxx(secret, [{ start: 0, end: 8 }]);
    assert.ok(!out.includes('9') && !out.includes(secret));
  });
});
