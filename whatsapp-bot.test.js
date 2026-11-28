'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractDigits } = require('./lib/lid');
const { isLidId, phoneLookupId, phoneFromLidMapping, resolveRealNumber } = require('./lib/lid');
const { shouldIgnoreMessage, isOfficialWhatsAppId } = require('./lib/filters');
const { matchObviousScam } = require('./lib/link-rules');
const { applyBlockPolicy } = require('./lib/block-policy');
const { JevlikeClient, resolveMaskUrl } = require('./lib/jevlike-client');
const { processIncomingMessage } = require('./lib/handle-incoming');
const { handleWaMessage } = require('./whatsapp-bot');
const { createActionPacer } = require('./lib/action-pacer');
const { createRecentContext } = require('./lib/context-llm');
const { createOperatorState } = require('./lib/operator-mode');
const { createReviewQueue } = require('./lib/review-queue');
const { llmChatResponse } = require('./lib/test-llm');
const { createStubJevlikeClient } = require('./stub-jevlike');

describe('phone digits', () => {
  it('strips plus, spaces, and 00 prefix', () => {
    assert.equal(extractDigits('+852 6123 4567'), '85261234567');
    assert.equal(extractDigits('00886123456789'), '886123456789');
  });
});

describe('LID handling', () => {
  it('detects @lid ids and never treats LID user digits as a ready phone', () => {
    assert.equal(isLidId('27028229202012@lid'), true);
    assert.equal(isLidId('85261234567@c.us'), false);
  });

  it('extracts real numbers from mappings and skips @lid values', () => {
    assert.equal(
      extractDigits(phoneFromLidMapping({ pn: '85261234567@c.us' })),
      '85261234567',
    );
    assert.equal(phoneFromLidMapping({ pn: '27028229202012@lid' }), null);
    assert.equal(
      phoneFromLidMapping({
        _serialized: '27028229202012@lid',
        user: '27028229202012',
        server: 'lid',
      }),
      null,
    );
    assert.equal(
      phoneFromLidMapping({
        _serialized: '27028229202012@lid',
        user: '27028229202012',
        server: 'lid',
        pn: '85261234567@c.us',
      }),
      '85261234567@c.us',
    );
  });

  it('resolveRealNumber does not use LID digits when lookup fails', async () => {
    const unresolved = await resolveRealNumber(
      { getContactLidAndPhone: async () => null },
      '27028229202012@lid',
      null,
    );
    assert.equal(unresolved.unresolvedLid, true);
    assert.equal(unresolved.digits, null);

    const resolved = await resolveRealNumber(
      { getContactLidAndPhone: async () => [{ pn: '+85261234567' }] },
      '27028229202012@lid',
      null,
    );
    assert.equal(resolved.unresolvedLid, false);
    assert.equal(resolved.digits, '85261234567');
    assert.notEqual(resolved.digits, '27028229202012');
  });

  it('keeps a known phone jid when the other id is a LID', async () => {
    assert.equal(phoneLookupId('27028229202012@lid', '85260001111@c.us'), '85260001111@c.us');
    assert.equal(phoneLookupId('85260001111@c.us', '27028229202012@lid'), '85260001111@c.us');
    assert.equal(phoneLookupId('27028229202012@lid', '888@lid'), '27028229202012@lid');
    const resolved = await resolveRealNumber(
      {
        async getContactLidAndPhone() {
          throw new Error('phone jid should not need a lookup');
        },
      },
      '85260001111@c.us',
      {
        number: '27028229202012',
        id: { user: '27028229202012', server: 'lid', _serialized: '27028229202012@lid' },
      },
    );
    assert.equal(resolved.digits, '85260001111');
    assert.equal(resolved.unresolvedLid, false);
  });
});

describe('filters', () => {
  it('ignores fromMe, groups, notifications, isMe, and official WhatsApp chats', () => {
    assert.equal(shouldIgnoreMessage({ fromMe: true }).ignore, true);
    assert.equal(shouldIgnoreMessage({ isGroup: true }).ignore, true);
    assert.equal(shouldIgnoreMessage({ isMe: true }).ignore, true);
    assert.equal(shouldIgnoreMessage({ type: 'notification' }).ignore, true);
    assert.equal(shouldIgnoreMessage({ type: 'e2e_notification' }).reason, 'notification');
    assert.equal(
      shouldIgnoreMessage({ chatId: 'status@broadcast' }).reason,
      'official_whatsapp',
    );
    assert.equal(
      shouldIgnoreMessage({ chatId: '0@c.us' }).reason,
      'official_whatsapp',
    );
    assert.equal(
      shouldIgnoreMessage({ from: '0@s.whatsapp.net' }).reason,
      'official_whatsapp',
    );
    assert.equal(isOfficialWhatsAppId('85260000000@c.us'), false);
    assert.equal(
      shouldIgnoreMessage({
        type: 'chat',
        pushName: 'WhatsApp Security',
        contactName: 'WhatsApp',
        chatId: '85260000000@c.us',
      }).ignore,
      false,
    );
    assert.equal(shouldIgnoreMessage({ type: 'chat' }).ignore, false);
  });
});

describe('heuristics', () => {
  it('hard-hits only link rules, not phrase tropes', () => {
    assert.equal(matchObviousScam('您的驗證碼即將過期，請立即回覆').hit, false);
    assert.equal(matchObviousScam('請把驗證碼發給我').hit, false);
    assert.equal(matchObviousScam('請用轉數快立即轉帳到此帳戶').hit, false);
    assert.equal(matchObviousScam('轉數快立即轉帳俾我').hit, false);
    assert.equal(matchObviousScam('新聞：有騙徒要求用轉數快立即轉帳').hit, false);
    assert.equal(matchObviousScam('WhatsApp 官方通知：否則封號').hit, false);
    assert.equal(matchObviousScam('WhatsApp official will ban this account').hit, false);
    assert.equal(matchObviousScam('WhatsApp 官方 bank 通知').hit, false);
    assert.equal(matchObviousScam('Send USDT to this wallet address now').hit, false);
    assert.equal(matchObviousScam('新聞：騙徒叫人 send USDT to this wallet').hit, false);
    assert.equal(matchObviousScam('順豐包裹清關費 http://bit.ly/x').hit, false);
    assert.equal(matchObviousScam('您的驗證碼即將過期，請到櫃檯').hit, false);
    assert.equal(matchObviousScam('您的驗證碼即將過期 https://example.com/pay').hit, false);
    assert.equal(
      matchObviousScam('登入 https://whatsapp-secure.com/login').id,
      'lookalike_domain',
    );
    assert.equal(
      matchObviousScam('請提供驗證碼 https://bit.ly/fee').hit,
      false,
    );
    assert.equal(
      matchObviousScam('順豐包裹清關 https://www.sf-express.com/hk').hit,
      false,
    );
    assert.equal(
      matchObviousScam('順豐包裹清關 https://hkt.sf-express.com/hk').hit,
      false,
    );
    assert.equal(
      matchObviousScam(
        `順豐包裹清關 ${'。'.repeat(120)} https://bit.ly/later`,
      ).hit,
      false,
    );
    assert.equal(
      matchObviousScam(
        '順豐包裹清關 https://www.sf-express.com/hk 同埋 http://bit.ly/fee',
      ).hit,
      false,
    );
    assert.equal(matchObviousScam('驗證碼過期，切勿提供給他人').hit, false);
  });

  it('does not fire on ordinary chat', () => {
    assert.equal(matchObviousScam('今晚食飯嗎？我轉帳比你 AA').hit, false);
    assert.equal(matchObviousScam('ok thanks').hit, false);
  });

  it('can be disabled via env', () => {
    const text = '登入 https://whatsapp-secure.com/login';
    assert.equal(matchObviousScam(text).hit, true);
    assert.equal(matchObviousScam(text, { HEURISTIC_ENABLED: 'false' }).hit, false);
  });
});

describe('applyBlockPolicy upgrades', () => {
  it('only malicious_host upgrades an AI-confirmed archive to auto-block for unsaved contacts', () => {
    const lookalike = { hit: true, id: 'lookalike_domain', archiveReason: null };
    const notBlocked = applyBlockPolicy({ action: 'archive', archiveReason: 'llm_review_scam' }, {
      savedContact: false,
      heuristic: lookalike,
    });
    assert.equal(notBlocked.action, 'archive');

    const malicious = { hit: true, id: 'malicious_host', archiveReason: null };
    const blocked = applyBlockPolicy({ action: 'archive', archiveReason: 'llm_review_scam' }, {
      savedContact: false,
      heuristic: malicious,
    });
    assert.equal(blocked.action, 'block');
    assert.equal(blocked.contactName, '封鎖·惡意域名');
  });
});

describe('JevlikeClient mask config', () => {
  it('keeps a usable mask URL and timeout', () => {
    assert.equal(
      resolveMaskUrl('http://127.0.0.1:8766/v1'),
      'http://127.0.0.1:8766/v1/mask',
    );
    assert.equal(
      resolveMaskUrl('http://127.0.0.1:8766'),
      'http://127.0.0.1:8766/v1/mask',
    );
    const client = new JevlikeClient({
      fetchImpl: async () => new Response('{}'),
      timeoutMs: 0,
    });
    assert.equal(client.timeoutMs, 30000);
    const fromEnv = new JevlikeClient({
      fetchImpl: async () => new Response('{}'),
      env: { JEVLIKE_TIMEOUT_MS: 'nope' },
    });
    assert.equal(fromEnv.timeoutMs, 30000);
  });
});

describe('processIncomingMessage', () => {
  it('skips groups before masking', async () => {
    let masked = false;
    const out = await processIncomingMessage(
      { isGroup: true, body: 'hi', chatId: 'g' },
      {
        maskClient: {
          async maskMessages() {
            masked = true;
            return { messages: [{ spans: [] }] };
          },
        },
      },
    );
    assert.equal(out.ignored, true);
    assert.equal(masked, false);
  });

  it('archives via callback when LLM says scam', async () => {
    const { primaryPathDeps, scamLlmFetch } = require('./lib/test-llm');
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '今晚食飯嗎',
        chatId: '85261234567@c.us',
        savedContact: false,
        messageId: 'm1',
      },
      primaryPathDeps({
        fetchImpl: scamLlmFetch(),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => {
          reasons.push(reason);
        },
      }),
    );
    assert.equal(out.ignored, false);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.deepEqual(reasons, ['llm_review_scam']);
  });

  it('does not archive when mask fails for local unsaved', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'hello',
        chatId: '852@c.us',
        savedContact: false,
      },
      {
        maskClient: {
          async maskMessages() {
            throw new Error('mask timeout');
          },
        },
        llmReview: { enabled: true, apiUrl: 'http://llm.test/v1', fetchImpl: async () => { throw new Error('no'); } },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('does not archive an unsaved non-local number when LLM says not_scam', async () => {
    const { primaryPathDeps, notScamLlmFetch } = require('./lib/test-llm');
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'Hi',
        chatId: '14155550123@c.us',
        savedContact: false,
        messageId: 'foreign-hi',
      },
      primaryPathDeps({
        fetchImpl: notScamLlmFetch(),
        resolveNumber: async () => ({
          digits: '14155550123',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.archiveReason, null);
    assert.deepEqual(reasons, []);
  });
});

describe('mask cache reuse through WhatsApp orchestration', () => {
  function reviewAndGuideFetch(prompts) {
    return async (_url, options) => {
      prompts.push(JSON.parse(options.body));
      return llmChatResponse({
        action: 'archive',
        pitch: false,
        strong: true,
        confidence: 0.95,
        reason: 'otp request',
        guide: '呢句催你交驗證碼。用官方渠道核實。',
      })();
    };
  }

  function harness(chatId, prior, current, prompts) {
    const recentContext = createRecentContext();
    recentContext.push(chatId, prior, { messageId: 'prior-inbound' });
    const batches = [];
    const stubMaskClient = createStubJevlikeClient();
    const sent = [];
    const events = [];
    const client = {
      info: { wid: { _serialized: 'me@c.us' } },
      async sendMessage(_wid, payload) {
        sent.push(payload);
        return { id: { _serialized: `sent-${sent.length}` } };
      },
    };
    const chat = {
      id: { _serialized: chatId },
      isGroup: false,
      async archive() {
        events.push('archive');
      },
    };
    const contact = {
      id: { _serialized: chatId, user: chatId.split('@')[0] },
      number: chatId.split('@')[0],
      isMyContact: false,
      isMe: false,
      pushname: 'Stranger',
    };
    const msg = {
      from: chatId,
      type: 'chat',
      body: current,
      id: { _serialized: 'current-inbound' },
      async getChat() {
        return chat;
      },
      async getContact() {
        return contact;
      },
      async forward() {
        events.push('forward');
      },
    };
    const deps = {
      client,
      pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
      recentContext,
      env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
      maskClient: {
        async maskMessages(messages) {
          batches.push([...messages]);
          return stubMaskClient.maskMessages(messages);
        },
      },
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: reviewAndGuideFetch(prompts),
      },
    };
    return { batches, sent, events, msg, deps };
  }

  function assertBodiesMaskedOnce(batches, prompts, prior, current) {
    assert.deepEqual(batches, [[prior, current], []]);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      const serialized = JSON.stringify(prompt);
      assert.equal(serialized.includes('91234567'), false);
      assert.equal(serialized.includes('陳大文'), false);
      assert.match(serialized, /<NAME_1>/);
    }
  }

  it('masks each body once across context review and the automatic action receipt', async () => {
    const chatId = '85260009999@c.us';
    const prior = '我係陳大文 電話 91234567';
    const current = '請把驗證碼發給我';
    const prompts = [];
    const { batches, sent, events, msg, deps } = harness(chatId, prior, current, prompts);
    const out = await handleWaMessage(msg, {
      ...deps,
      operator: { mode: () => 'auto', awaitingChoice: () => false },
      reviewQueue: null,
    });
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.archived, true);
    assert.deepEqual(events, ['archive']);
    assertBodiesMaskedOnce(batches, prompts, prior, current);
    assert.equal(sent.length, 1);
    assert.match(String(sent[0]), /已封存，未封鎖/);
  });

  it('masks each body once across context review and the guided review card', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-cache-guided-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const chatId = '85260009998@c.us';
    const prior = '我係陳大文 電話 91234567';
    const current = '請把驗證碼發給我';
    const prompts = [];
    const { batches, sent, events, msg, deps } = harness(chatId, prior, current, prompts);
    const out = await handleWaMessage(msg, {
      ...deps,
      operator: createOperatorState({
        env: { OPERATOR_MODE: 'guided' },
        filePath: path.join(dir, 'mode.json'),
      }),
      reviewQueue: createReviewQueue({ filePath: path.join(dir, 'queue.json') }),
    });
    assert.equal(out.deferred, true);
    assert.equal(out.decision.action, 'archive');
    assert.deepEqual(events, ['forward']);
    assertBodiesMaskedOnce(batches, prompts, prior, current);
    assert.equal(sent.length, 2);
    assert.match(String(sent[0]), /模型講解/);
  });
});
