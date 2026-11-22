'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findMaskSpans } = require('../test/support/mask-spans-stub');
const { applyXxx } = require('./pii-xxx');
const {
  createRecentContext,
  maskOneForLlm,
  applyContextLlmDecision,
} = require('./context-llm');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');

function llmJson(action, confidence = 0.9) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ action, confidence, reason: 'test' }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('mask spans', () => {
  it('replaces phone, name, and otp with XXX and keeps the lure word', () => {
    const text = '我係陳大文，電話 +852 6123 4567，驗證碼 123456';
    const masked = maskOneForLlm(text, findMaskSpans(text));
    assert.match(masked, /XXX/);
    assert.match(masked, /驗證碼/);
    assert.match(masked, /我係/);
    assert.doesNotMatch(masked, /6123/);
    assert.doesNotMatch(masked, /陳大文/);
    assert.doesNotMatch(masked, /123456/);
  });

  it('leaves organisation tails, roles, and years', () => {
    for (const text of ['我係收數公司', '我係張經理', '如非本人操作', '今晚2026年見']) {
      assert.equal(applyXxx(text, findMaskSpans(text)), text);
    }
  });

  it('keeps a URL host and hides the path', () => {
    const text = '睇 https://evil.example/secret?x=1';
    const masked = applyXxx(text, findMaskSpans(text));
    assert.match(masked, /evil\.example/);
    assert.doesNotMatch(masked, /secret/);
    assert.match(masked, /XXX/);
  });

  it('hides URL userinfo and an IDN path', () => {
    assert.equal(
      applyXxx('https://alice:s3cret!@evil.example/reset', findMaskSpans('https://alice:s3cret!@evil.example/reset')),
      'https://XXX@evil.example XXX',
    );
    const idn = 'https://例子.測試/secret-token';
    const masked = applyXxx(idn, findMaskSpans(idn));
    assert.match(masked, /例子\.測試/);
    assert.doesNotMatch(masked, /secret-token/);
  });

  it('masks identifiers that sit against Chinese', () => {
    assert.equal(applyXxx('電郵user@example.com請回覆', findMaskSpans('電郵user@example.com請回覆')), '電郵XXX請回覆');
    assert.equal(applyXxx('請開wa.me/abc123secret', findMaskSpans('請開wa.me/abc123secret')), '請開wa.me/XXX');
    assert.match(applyXxx('用payme abcd1234轉帳', findMaskSpans('用payme abcd1234轉帳')), /payme XXX/);
  });
});

describe('recent context chat capacity', () => {
  it('evicts the least recently pushed chat without changing the message cap', () => {
    const recent = createRecentContext({ limit: 2, maxChats: 2 });
    recent.push('a', 'one');
    recent.push('b', 'other');
    recent.push('a', 'two');
    recent.push('a', 'three');
    recent.recent('b');
    recent.push('c', 'new');
    assert.deepEqual(recent.recent('b'), []);
    assert.deepEqual(recent.recent('a'), ['two', 'three']);
    assert.deepEqual(recent.recent('c'), ['new']);
  });

  it('retains the pushed chat with a minimum capacity of one', () => {
    for (const maxChats of [1, 0, -1, 0.5]) {
      const recent = createRecentContext({ maxChats });
      recent.push('a', 'old');
      recent.push('b', 'new');
      recent.push('b', '');
      recent.push('', 'ignored');
      assert.deepEqual(recent.recent('a'), []);
      assert.deepEqual(recent.recent('b'), ['new']);
    }
  });

});

describe('recent context', () => {
  it('drops the original when an edit is empty', () => {
    const recent = createRecentContext();
    recent.push('chat', 'a');
    recent.push('chat', 'scam text');
    recent.push('chat', '', { replaces: 'scam text' });
    assert.deepEqual(recent.recent('chat'), ['a']);
  });

  it('keeps the latest 10 messages and drops the oldest', () => {
    const recent = createRecentContext({ limit: 10 });
    for (let i = 1; i <= 11; i += 1) {
      recent.push('chat', `MSG${String(i).padStart(2, '0')}`);
    }
    const window = recent.recent('chat');
    assert.equal(window.length, 10);
    assert.equal(window[0], 'MSG02');
    assert.equal(window[9], 'MSG11');
    assert.equal(window.includes('MSG01'), false);
  });

  it('keeps an edited message once, as its new text', () => {
    const recent = createRecentContext({ limit: 10 });
    recent.push('chat', 'first');
    recent.push('chat', 'scam text');
    recent.push('chat', 'Hello', { replaces: 'scam text' });
    assert.deepEqual(recent.recent('chat'), ['first', 'Hello']);
  });
});

describe('applyContextLlmDecision', () => {
  it('does not let a failed review archive', () => {
    const decision = { action: 'ignore', archiveReason: null };
    const next = applyContextLlmDecision(decision, {
      ok: false,
      action: null,
      reason: 'llm_timeout',
    });
    assert.equal(next.action, 'ignore');
  });

  it('keeps ignore when the model says no_action', () => {
    const next = applyContextLlmDecision(
      { action: 'ignore', archiveReason: null },
      { ok: true, action: 'no_action' },
      { savedContact: false },
    );
    assert.equal(next.action, 'ignore');
  });

  it('archives from ignore when the model says archive', () => {
    const next = applyContextLlmDecision(
      { action: 'ignore', archiveReason: null },
      { ok: true, action: 'archive', confidence: 0.85, reason: 'suspicious' },
      { savedContact: false },
    );
    assert.equal(next.action, 'archive');
    assert.equal(next.archiveReason, 'context_llm');
  });

  it('does not archive when confidence is below the threshold', () => {
    const decision = { action: 'ignore', archiveReason: null };
    const next = applyContextLlmDecision(
      decision,
      { ok: true, action: 'archive', confidence: 0.5, reason: 'weak' },
      { env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' } },
    );
    assert.equal(next, decision);
  });
});

describe('processIncomingMessage context llm', () => {
  for (const earlier of [[], ['a']]) {
    it(`does not resend the original after an empty edit with ${earlier.length} earlier messages`, async () => {
      const recentContext = createRecentContext();
      const seen = [];
      const deps = {
        env: { CONTEXT_LLM_ENABLED: 'true', HEURISTIC_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
        recentContext,
        maskClient: createStubJevlikeClient(0.1),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            seen.push(JSON.parse(opts.body).messages[1].content);
            return llmJson('no_action')();
          },
        },
      };
      const send = (body, editedFrom) => processIncomingMessage(
        { type: 'chat', chatId: 'empty-edit@c.us', body },
        { ...deps, editedFrom },
      );
      for (const body of earlier) await send(body);
      await send('scam text');
      seen.length = 0;
      const out = await send('', 'scam text');
      assert.deepEqual(seen, earlier.length ? ['[1] a'] : []);
      assert.deepEqual(recentContext.recent('empty-edit@c.us'), earlier);
      assert.equal(out.decision.action, 'ignore');
      if (!earlier.length) assert.equal(out.llmTrigger.skipped, 'empty');
    });
  }

  it('sends the masked recent messages and archives when the model says archive', async () => {
    const recent = createRecentContext({ limit: 10 });
    const seen = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '我係陳大文，電話 +852 6123 4567，驗證碼 123456，請你考慮',
        chatId: '85260000000@c.us',
        savedContact: true,
        messageId: 'ctx-1',
      },
      {
        env: { CONTEXT_LLM_ENABLED: 'true', HEURISTIC_ENABLED: 'false' },
        maskClient: createStubJevlikeClient(0.1),
        recentContext: recent,
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            seen.push(JSON.parse(opts.body));
            return llmJson('archive')();
          },
        },
        resolveNumber: async () => ({ digits: '85260000000', unresolvedLid: false }),
        archiveChat: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'context_llm');
    assert.equal(seen.length, 1);
    const user = seen[0].messages.find((message) => message.role === 'user').content;
    assert.match(user, /\[1\] /);
    assert.match(user, /XXX/);
    assert.match(user, /驗證碼/);
    assert.doesNotMatch(user, /6123/);
    assert.doesNotMatch(user, /陳大文/);
    assert.doesNotMatch(user, /123456/);
    assert.doesNotMatch(JSON.stringify(seen[0]), /mapping/);
  });

  it('sends the latest 10 messages, including the one that just arrived', async () => {
    const recent = createRecentContext({ limit: 10 });
    for (let i = 1; i <= 10; i += 1) recent.push('c1', `MSG${String(i).padStart(2, '0')}`);
    const seen = [];
    await processIncomingMessage(
      {
        type: 'chat',
        body: 'MSG11 unique tail',
        chatId: 'c1',
        savedContact: true,
        messageId: 'ctx-11',
      },
      {
        maskClient: createStubJevlikeClient(0.1),
        recentContext: recent,
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            seen.push(JSON.parse(opts.body));
            return llmJson('no_action')();
          },
        },
        resolveNumber: async () => ({ digits: null, unresolvedLid: false }),
      },
    );
    const user = seen[0].messages.find((message) => message.role === 'user').content;
    assert.match(user, /MSG02/);
    assert.match(user, /MSG10/);
    assert.match(user, /MSG11 unique tail/);
    assert.doesNotMatch(user, /MSG01/);
  });

  it('does not block a saved contact when the model says block', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請你今日內回覆我這個邀請',
        chatId: 'c-saved',
        savedContact: true,
        messageId: 'ctx-saved',
      },
      {
        maskClient: createStubJevlikeClient(0.96),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmJson('block'),
        },
        resolveNumber: async () => ({ digits: '85261111111', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(blocked, false);
  });

  it('archives only when the context model says block (no auto-block)', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請你今日內回覆我這個邀請',
        chatId: 'c-low',
        savedContact: false,
        messageId: 'ctx-low',
      },
      {
        maskClient: createStubJevlikeClient(0.1),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmJson('block'),
        },
        resolveNumber: async () => ({ digits: '85262222222', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'context_llm');
    assert.equal(out.decision.blockReason, undefined);
    assert.equal(blocked, false);
  });

  it('stays ignore when archive confidence is below the threshold', async () => {
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請你今日內回覆我這個邀請',
        chatId: 'c-low-conf',
        savedContact: false,
        messageId: 'ctx-low-conf',
      },
      {
        env: { CONTEXT_LLM_ENABLED: 'true', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient(0.1),
        recentContext: createRecentContext({ limit: 10 }),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmJson('archive', 0.4),
        },
        resolveNumber: async () => ({ digits: '85263333333', unresolvedLid: false }),
        archiveChat: async () => {},
      },
    );
    assert.equal(out.decision.action, 'ignore');
  });

  it('stays ignore when the model says no_action on the primary path', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請你今日內回覆我這個邀請',
        chatId: 'c-high',
        savedContact: false,
        messageId: 'ctx-no-action',
      },
      {
        maskClient: createStubJevlikeClient(0.96),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmJson('no_action'),
        },
        resolveNumber: async () => ({ digits: '85263333333', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(blocked, false);
  });

  it('skips the model on an obvious-scam heuristic', async () => {
    let called = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: 'c-heur',
        savedContact: false,
        messageId: 'ctx-heur',
      },
      {
        maskClient: createStubJevlikeClient(0.1),
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            called = true;
            return llmJson('no_action')();
          },
        },
        resolveNumber: async () => ({ digits: '85264444444', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
      },
    );
    assert.equal(called, false);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.llmTrigger.skipped, 'hard_archive');
  });

  it('does not call the model when masking fails', async () => {
    let called = false;
    const client = createStubJevlikeClient(0.1);
    client.maskMessages = async () => {
      throw new Error('worker down');
    };
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '普通一句問候，今日天氣不錯',
        chatId: 'c-mask',
        savedContact: false,
        messageId: 'ctx-mask',
      },
      {
        maskClient: client,
        contextLlm: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async () => {
            called = true;
            return llmJson('archive')();
          },
        },
        resolveNumber: async () => ({ digits: null, unresolvedLid: false }),
      },
    );
    assert.equal(called, false);
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.llmTrigger.skipped, 'mask_failed');
  });
});
