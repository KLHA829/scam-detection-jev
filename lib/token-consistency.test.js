'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reviewOpeningMessages } = require('./context-llm');
const { createRecentContext, maskOneForLlm, CONTEXT_SYSTEM_PROMPT } = require('./context-llm');
const { withOfficialHosts } = require('./llm-review');
const { officialHosts } = require('./link-rules');

function spansFor(body) {
  // mask every digit run as the neural head would
  const spans = [];
  for (const m of body.matchAll(/[0-9+][0-9 ]{5,}/g)) spans.push({ start: m.index, end: m.index + m[0].length });
  return { spans };
}

describe('mask token consistency across reviews of one chat', () => {
  it('keeps one token per value and never shares one token across values', async () => {
    const ctx = createRecentContext({ turns: 10 });
    const chatId = 'consistency@c.us';
    const maskClient = {
      maskMessages: async (bodies) => ({ messages: bodies.map(spansFor) }),
    };
    const seen = [];
    const llmOptions = {
      apiUrl: 'http://llm.test/v1',
      fetchImpl: async (_url, opts) => {
        seen.push(JSON.parse(opts.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"action":"no_action","confidence":0.9,"reason":"ok"}' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    };
    // review 1: phone A arrives; review 2: different phone B arrives.
    ctx.push(chatId, '我個號碼係 6123 4567', { messageId: 'm1' });
    await reviewOpeningMessages({
      turns: [{ fromMe: false, body: '我個號碼係 6123 4567' }],
      maskClient, llmOptions, env: {}, maskCache: ctx.maskCache(chatId),
    });
    ctx.push(chatId, '唔該轉去 9876 5432', { messageId: 'm2' });
    await reviewOpeningMessages({
      turns: [
        { fromMe: false, body: '我個號碼係 6123 4567' },
        { fromMe: false, body: '唔該轉去 9876 5432，舊號係 6123 4567' },
      ],
      maskClient, llmOptions, env: {}, maskCache: ctx.maskCache(chatId),
    });
    const transcript2 = seen[1].messages.find((m) => m.role === 'user').content;
    const tokenA = transcript2.match(/<PHONE_\d+>/g);
    assert.ok(tokenA, transcript2);
    const unique = new Set(tokenA);
    assert.equal(unique.size, 2, `two different numbers must not share one token: ${transcript2}`);
    // The repeated 6123 4567 in the fresh turn must reuse the same token the
    // cached turn carries — same value, same token, across batches.
    const perLine = transcript2.split('\n').map((line) => line.match(/<PHONE_\d+>/g) || []);
    assert.equal(perLine.length >= 2 ? perLine[1].filter((t) => perLine[0].includes(t)).length : 0, 1,
      `the repeated number must reuse its token across batches: ${transcript2}`);
  });
});

describe('official host vouching', () => {
  it('does not vouch for a host glued to a mask token', () => {
    assert.deepEqual(officialHosts('登入 https://hsbc.com.hk/secure 即刻').map((h) => h.host), ['hsbc.com.hk']);
    assert.deepEqual(officialHosts('https://hsbc.com.hk<PII_1>'), []);
    assert.deepEqual(officialHosts('<PII_1>hsbc.com.hk/x'), []);
  });

  it('does not vouch for an official-looking fragment left by partial masking', () => {
    const text = '登入 https://payme.hsbc.evil.com/login';
    const start = text.indexOf('evil.com');
    const masked = maskOneForLlm(text, [{ start, end: start + 'evil.com'.length }]);
    assert.match(masked, /payme\.hsbc\.<URL_1>\/login/);
    assert.equal(withOfficialHosts(CONTEXT_SYSTEM_PROMPT, masked), CONTEXT_SYSTEM_PROMPT);
  });
});
