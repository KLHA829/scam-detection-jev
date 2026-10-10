'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findMaskSpans, applyXxx } = require('./mask-spans');
const {
  createRecentContext,
  maskOneForLlm,
  applyContextLlmDecision,
} = require('./context-llm');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

function llmJson(action) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action, reason: 'test' }) } }],
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
});

describe('recent context', () => {
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

  it('releases a mid score archive on no_action', () => {
    const next = applyContextLlmDecision(
      { action: 'archive', archiveReason: 'jevlike_score' },
      { ok: true, action: 'no_action' },
      { savedContact: false, scoreResult: { ok: true, label: 'scam', score: 50 } },
    );
    assert.equal(next.action, 'ignore');
    assert.equal(next.released, true);
  });

  it('keeps a block-line score archive on no_action', () => {
    const next = applyContextLlmDecision(
      { action: 'archive', archiveReason: 'jevlike_score' },
      { ok: true, action: 'no_action' },
      { savedContact: false, scoreResult: { ok: true, label: 'scam', score: 96 } },
    );
    assert.equal(next.action, 'archive');
  });

  it('keeps a saved contact block-line archive on no_action', () => {
    const next = applyContextLlmDecision(
      { action: 'archive', archiveReason: 'jevlike_score' },
      { ok: true, action: 'no_action' },
      { savedContact: true, scoreResult: { ok: true, label: 'scam', score: 96 } },
    );
    assert.equal(next.action, 'archive');
    assert.equal(next.released, undefined);
  });

  it('releases a saved contact mid-score archive on no_action', () => {
    const next = applyContextLlmDecision(
      { action: 'archive', archiveReason: 'jevlike_score' },
      { ok: true, action: 'no_action' },
      { savedContact: true, scoreResult: { ok: true, label: 'scam', score: 50 } },
    );
    assert.equal(next.action, 'ignore');
    assert.equal(next.released, true);
  });
});

describe('processIncomingMessage context llm', () => {
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
        scoreClient: createStubJevlikeClient(0.1),
        rubric,
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
        scoreClient: createStubJevlikeClient(0.1),
        rubric,
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
        scoreClient: createStubJevlikeClient(0.96),
        rubric,
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

  it('does not block an unsaved low score when the model says block', async () => {
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
        scoreClient: createStubJevlikeClient(0.1),
        rubric,
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
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'context_llm');
    assert.equal(blocked, false);
  });

  it('still blocks an unsaved contact at the block line when the model says no_action', async () => {
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請你今日內回覆我這個邀請',
        chatId: 'c-high',
        savedContact: false,
        messageId: 'ctx-high',
      },
      {
        scoreClient: createStubJevlikeClient(0.96),
        rubric,
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
    assert.equal(out.decision.action, 'block');
    assert.equal(blocked, true);
  });

  it('skips the model on an obvious-scam heuristic', async () => {
    let called = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請把驗證碼發給我',
        chatId: 'c-heur',
        savedContact: false,
        messageId: 'ctx-heur',
      },
      {
        scoreClient: createStubJevlikeClient(0.1),
        rubric,
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
    assert.equal(out.decision.action, 'block');
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
        scoreClient: client,
        rubric,
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
