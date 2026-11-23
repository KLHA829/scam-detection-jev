'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findMaskSpans } = require('../test/support/mask-spans-stub');
const { applyXxx } = require('./pii-xxx');
const {
  createRecentContext,
  maskOneForLlm,
  applyContextLlmDecision,
  clearsPitchLabel,
  CONTEXT_SYSTEM_PROMPT,
} = require('./context-llm');
const { processIncomingMessage, recordOutgoingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { llmChatResponse } = require('./test-llm');

function llmJson(action, confidence = 0.9) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ action, strong: true, confidence, reason: 'test' }),
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
    assert.deepEqual(recent.recent('a').map(({ body }) => body), ['two', 'three']);
    assert.deepEqual(recent.recent('c').map(({ body }) => body), ['new']);
  });

  it('retains the pushed chat with a minimum capacity of one', () => {
    for (const maxChats of [1, 0, -1, 0.5]) {
      const recent = createRecentContext({ maxChats });
      recent.push('a', 'old');
      recent.push('b', 'new');
      recent.push('b', '');
      recent.push('', 'ignored');
      assert.deepEqual(recent.recent('a'), []);
      assert.deepEqual(recent.recent('b').map(({ body }) => body), ['new']);
    }
  });

});

describe('recent context', () => {
  it('drops the original when an edit is empty', () => {
    const recent = createRecentContext();
    recent.push('chat', 'a');
    recent.push('chat', 'scam text');
    recent.push('chat', '', { replaces: 'scam text' });
    assert.deepEqual(recent.recent('chat'), [{ fromMe: false, body: 'a' }]);
  });

  it('keeps the latest 10 messages and drops the oldest', () => {
    const recent = createRecentContext({ limit: 10 });
    for (let i = 1; i <= 11; i += 1) {
      recent.push('chat', `MSG${String(i).padStart(2, '0')}`);
    }
    const window = recent.recent('chat').map(({ body }) => body);
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
    assert.deepEqual(recent.recent('chat').map(({ body }) => body), ['first', 'Hello']);
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

describe('context model pitch label', () => {
  const env = { LLM_REVIEW_MIN_CONFIDENCE: '0.7' };
  const ignore = { action: 'ignore', archiveReason: null };
  const pitch = (action = 'no_action', confidence = 0.6) => ({ ok: true, action, pitch: true, confidence, reason: 'pitch' });
  const label = { action: 'label', labelReason: 'context_llm_pitch', contactName: '（可疑推銷）' };

  it('labels an unsaved sender when the review does not archive', () => {
    assert.deepEqual(applyContextLlmDecision(ignore, pitch(), { savedContact: false, env }), label);
    assert.deepEqual(applyContextLlmDecision(ignore, pitch('archive', 0.6), { savedContact: false, env }), label);
  });

  it('still archives a confident scam verdict instead of labelling', () => {
    assert.deepEqual(
      applyContextLlmDecision(ignore, pitch('block', 0.9), { savedContact: false, env }),
      { action: 'archive', archiveReason: 'context_llm' },
    );
  });

  it('leaves saved, unknown and non-pitch cases alone', () => {
    assert.equal(applyContextLlmDecision(ignore, pitch(), { savedContact: true, env }), ignore);
    assert.equal(applyContextLlmDecision(ignore, pitch(), { savedContact: null, env }), ignore);
    assert.equal(applyContextLlmDecision(ignore, { ...pitch(), pitch: false }, { savedContact: false, env }), ignore);
    assert.equal(applyContextLlmDecision(ignore, { ...pitch(), ok: false }, { savedContact: false, env }), ignore);
  });

  it('asks for a separate pitch verdict next to the unchanged actions', () => {
    assert.match(CONTEXT_SYSTEM_PROMPT, /"action":"archive"\|"block"\|"no_action","pitch":true\|false/);
    assert.match(CONTEXT_SYSTEM_PROMPT, /Set pitch true when the chat is an unsolicited investment, trading or health-product pitch/);
  });

  for (const savedContact of [false, true]) {
    it(`${savedContact ? 'never labels a saved contact' : 'labels an unsaved pitch'} through the handler`, async () => {
      const labels = [];
      const out = await processIncomingMessage(
        { type: 'chat', chatId: 'pitch@c.us', body: '王老師帶你炒股，每日穩賺5%，免費入群', savedContact },
        {
          env: { CONTEXT_LLM_ENABLED: 'true', HEURISTIC_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0', ...env },
          recentContext: createRecentContext(),
          maskClient: createStubJevlikeClient(0.1),
          contextLlm: {
            enabled: true,
            apiUrl: 'http://llm.test/v1',
            fetchImpl: llmChatResponse({ action: 'no_action', pitch: true, confidence: 0.6 }),
          },
          resolveNumber: async () => ({ digits: '85260000000', unresolvedLid: false }),
          archiveChat: async () => { throw new Error('pitch must not archive'); },
          labelContact: async (info) => { labels.push(info); return { labelled: true }; },
        },
      );
      assert.equal(out.archived, false);
      assert.equal(out.blocked, false);
      assert.equal(out.deferred, false);
      if (savedContact) {
        assert.equal(out.decision.action, 'ignore');
        assert.deepEqual(labels, []);
        assert.equal(out.labelled, false);
      } else {
        assert.equal(out.decision.action, 'label');
        assert.deepEqual(labels, [{ digits: '85260000000', contactName: '（可疑推銷）', chatId: 'pitch@c.us' }]);
        assert.equal(out.labelled, true);
      }
    });
  }
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
      assert.deepEqual(recentContext.recent('empty-edit@c.us').map(({ body }) => body), earlier);
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
    const system = seen[0].messages.find((message) => message.role === 'system').content;
    assert.match(system, /scam solicitation:[^.]+log in or share information via a deceptive link/);
    assert.match(system, /no_action for [^.]+warnings that quote a suspicious link/);
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

  it('skips the model on an explicit malicious URL', async () => {
    let called = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://malicious-block-test.invalid/login',
        chatId: 'c-heur',
        savedContact: true,
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

describe('CONTEXT_SYSTEM_PROMPT', () => {
  it('treats money received, own-account alerts and do-not-share codes as no_action', () => {
    assert.match(CONTEXT_SYSTEM_PROMPT, /no_action for ordinary chat \(including a message saying money was already sent to the user/);
    assert.match(CONTEXT_SYSTEM_PROMPT, /bank alert that only reports a transaction or login on the user's own account/);
    assert.match(CONTEXT_SYSTEM_PROMPT, /one-time code the user is told not to share/);
  });
});

describe('context review sees the user\'s own turns', () => {
  const chatId = '85291234567@c.us';
  const sellerReply = '收到你訂單，嬰兒車 $800，請轉數快到 91234567，收到款就寄出';

  async function reviewAfterOwnQuestion(recentContext) {
    const sent = [];
    recordOutgoingMessage(
      { type: 'chat', chatId, body: 'Carousell 見到你賣嬰兒車，我電話 61234567，點俾錢？', messageId: 'out-1' },
      { recentContext },
    );
    const out = await processIncomingMessage(
      { type: 'chat', body: sellerReply, chatId, savedContact: false },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0' },
        operatorMode: 'auto',
        maskClient: createStubJevlikeClient(),
        recentContext,
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (url, init) => {
            sent.push(JSON.parse(init.body).messages.at(-1).content);
            return llmJson('no_action')(url, init);
          },
        },
        resolveNumber: async () => ({ digits: '85291234567', unresolvedLid: false }),
        archiveChat: async () => {
          throw new Error('must not archive');
        },
      },
    );
    return { out, sent };
  }

  it('sends the user\'s question and the reply as masked turns marked by speaker', async () => {
    const { out, sent } = await reviewAfterOwnQuestion(createRecentContext());
    assert.equal(out.archived, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /\[1\] user: Carousell 見到你賣嬰兒車，我電話 XXX，點俾錢？/);
    assert.match(sent[0], /\[2\] 收到你訂單，嬰兒車 \$800，請轉數快到 XXX，收到款就寄出$/);
    assert.doesNotMatch(sent[0], /61234567|91234567/);
  });

  it('replaces an edited own turn in place and keeps the speaker', () => {
    const recent = createRecentContext();
    recent.push(chatId, '仲有冇貨？', { messageId: 'out-1', fromMe: true });
    recent.push(chatId, '有');
    recent.push(chatId, '仲有冇貨？點俾錢？', { messageId: 'out-1', fromMe: true });
    assert.deepEqual(recent.recent(chatId), [
      { fromMe: false, body: '有' },
      { fromMe: true, body: '仲有冇貨？點俾錢？' },
    ]);
  });

  it('does not record group, status or official WhatsApp chats', () => {
    const recent = createRecentContext();
    assert.equal(recordOutgoingMessage({ type: 'chat', chatId: 'g@g.us', isGroup: true, body: 'hi' }, { recentContext: recent }), false);
    assert.equal(recordOutgoingMessage({ type: 'chat', chatId: 'status@broadcast', body: 'hi' }, { recentContext: recent }), false);
    assert.equal(recordOutgoingMessage({ type: 'chat', chatId, body: 'hi' }, {}), false);
    assert.deepEqual(recent.recent('g@g.us'), []);
  });

  it('tells the model which lines are the user\'s and that a request they asked for is ordinary chat', () => {
    assert.match(CONTEXT_SYSTEM_PROMPT, /Lines that start with "user:" are the user's own messages/);
    assert.match(CONTEXT_SYSTEM_PROMPT, /booking or service the user asked for in those lines, that is ordinary chat/);
  });
});

describe('first contact needs strong evidence to archive', () => {
  const chatId = '85298765432@c.us';
  const clinic = '陳太你好，呢度係康健牙科，你喺診所留低電話預約洗牙，請先轉數快訂金 $200 到 23456789';

  function reviewWith(verdict) {
    return async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ confidence: 0.9, reason: 'test', ...verdict }) } }],
      }));
  }

  async function receive(body, verdict, recentContext = createRecentContext()) {
    const archives = [];
    const out = await processIncomingMessage(
      { type: 'chat', body, chatId, savedContact: false },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0' },
        operatorMode: 'auto',
        maskClient: createStubJevlikeClient(),
        recentContext,
        llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: reviewWith(verdict) },
        resolveNumber: async () => ({ digits: '85298765432', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
      },
    );
    return { out, archives };
  }

  it('holds a weak archive verdict on the first message from an unsaved number', async () => {
    const { out, archives } = await receive(clinic, { action: 'archive', strong: false });
    assert.equal(out.archived, false);
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(archives, []);
  });

  it('archives the first message at once on strong evidence', async () => {
    const { out } = await receive('你好，我係滙豐職員，你戶口異常，請即回覆驗證碼', { action: 'block', strong: true });
    assert.equal(out.archived, true);
    assert.equal(out.decision.archiveReason, 'context_llm');
  });

  it('archives a weak verdict once the sender writes again', async () => {
    const recent = createRecentContext();
    await receive('你好，有個投資機會想同你分享', { action: 'no_action' }, recent);
    const { out } = await receive('入金 $5000 到 23456789 就可以開始', { action: 'archive', strong: false }, recent);
    assert.equal(out.archived, true);
  });

  it('still labels a held first-contact pitch', async () => {
    const { out } = await receive('跟住老師炒美股，月賺20%，入群即送免費課程', { action: 'archive', strong: false, pitch: true });
    assert.equal(out.archived, false);
    assert.equal(out.decision.action, 'label');
  });

  it('asks the model for a separate strong-evidence verdict', () => {
    assert.match(CONTEXT_SYSTEM_PROMPT, /"strong":true\|false/);
    assert.match(CONTEXT_SYSTEM_PROMPT, /Set strong true only when the other party asks for a one-time code/);
  });
});

describe('clearsPitchLabel', () => {
  const env = { LLM_REVIEW_MIN_CONFIDENCE: '0.7' };
  const ordinary = { ok: true, action: 'no_action', pitch: false, confidence: 0.9 };

  it('lifts the label only on a confident ordinary verdict for an unsaved sender', () => {
    assert.equal(clearsPitchLabel(ordinary, { savedContact: false, env }), true);
    assert.equal(clearsPitchLabel({ ...ordinary, pitch: true }, { savedContact: false, env }), false);
    assert.equal(clearsPitchLabel({ ...ordinary, action: 'archive' }, { savedContact: false, env }), false);
    assert.equal(clearsPitchLabel({ ...ordinary, confidence: 0.5 }, { savedContact: false, env }), false);
    assert.equal(clearsPitchLabel({ ...ordinary, ok: false }, { savedContact: false, env }), false);
    assert.equal(clearsPitchLabel(ordinary, { savedContact: true, env }), false);
    assert.equal(clearsPitchLabel(null, { savedContact: false, env }), false);
  });
});
