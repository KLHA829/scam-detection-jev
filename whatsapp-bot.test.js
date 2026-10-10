'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractDigits } = require('./lib/foreign-number');
const { isLidId, lidUserPart, phoneFromLidMapping, resolveRealNumber } = require('./lib/lid');
const { shouldIgnoreMessage, isOfficialWhatsAppId } = require('./lib/filters');
const { matchObviousScam } = require('./lib/heuristics');
const { decideIncomingAction, resolveIncomingMessageLabel } = require('./lib/decide-incoming');
const { applyBlockPolicy } = require('./lib/block-policy');
const {
  loadRubric,
  labelFromScore,
  scoreMessage,
} = require('./lib/score-message');
const { JevlikeClient, resolveMaskUrl } = require('./lib/jevlike-client');
const { processIncomingMessage } = require('./lib/handle-incoming');
const { TtlCache, cacheKeyForMessage } = require('./lib/cache');
const {
  createStubJevlikeClient,
  createStubJevlikeFetch,
  PRESETS,
} = require('./stub-jevlike');

const rubric = loadRubric();

function scoreResult(overrides = {}) {
  return {
    score: 0,
    label: 'not_scam',
    ok: true,
    thresholds: rubric.thresholds,
    ...overrides,
  };
}

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
    assert.equal(lidUserPart('27028229202012@lid'), '27028229202012');
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

describe('loadRubric env', () => {
  it('keeps the rubric lines when a threshold is not a number', () => {
    const tuned = loadRubric(undefined, {
      ARCHIVE_THRESHOLD: 'nope',
      SAFE_THRESHOLD: 'nope',
      BLOCK_THRESHOLD: 'nope',
    });
    assert.equal(tuned.thresholds.archive, 42);
    assert.equal(tuned.thresholds.safe, 18);
    assert.equal(tuned.thresholds.block, 80);
    assert.equal(labelFromScore(96, tuned.thresholds), 'scam');
  });
});

describe('heuristics', () => {
  it('matches tight OTP / FPS / official-ban / USDT / SF tropes', () => {
    assert.equal(
      matchObviousScam('您的驗證碼即將過期，請立即回覆').hit,
      true,
    );
    assert.equal(
      matchObviousScam('請把驗證碼發給我').id,
      'otp_harvest',
    );
    assert.equal(
      matchObviousScam('請用轉數快立即轉帳到此帳戶').id,
      'fps_urgent_transfer',
    );
    assert.equal(
      matchObviousScam('WhatsApp 官方通知：否則封號').id,
      'wa_official_ban',
    );
    assert.equal(
      matchObviousScam('WhatsApp official will ban this account').id,
      'wa_official_ban',
    );
    assert.equal(matchObviousScam('WhatsApp 官方 bank 通知').hit, false);
    assert.equal(
      matchObviousScam('Send USDT to this wallet address now').id,
      'usdt_wallet_send',
    );
    assert.equal(
      matchObviousScam('順豐包裹清關費 http://bit.ly/x').id,
      'sf_customs_link',
    );
  });

  it('does not fire on ordinary chat', () => {
    assert.equal(matchObviousScam('今晚食飯嗎？我轉帳比你 AA').hit, false);
    assert.equal(matchObviousScam('ok thanks').hit, false);
  });

  it('can be disabled via env', () => {
    assert.equal(
      matchObviousScam('您的驗證碼即將過期', { HEURISTIC_ENABLED: 'false' }).hit,
      false,
    );
  });
});

describe('decideIncomingAction matrix', () => {
  it('archives on score >= T for any sender', () => {
    const high = scoreResult({ score: 50, label: 'scam' });
    assert.deepEqual(
      decideIncomingAction(high, '85261234567', true, { hit: false }),
      { action: 'archive', archiveReason: 'jevlike_score' },
    );
    assert.deepEqual(
      decideIncomingAction(high, '14155550123', false, { hit: true }),
      { action: 'archive', archiveReason: 'jevlike_score' },
    );
  });

  it('archives on obvious heuristic even when score is low', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: true }),
      { action: 'archive', archiveReason: 'obvious_scam' },
    );
  });

  it('does not archive unsaved non-local numbers from score-or-heuristic alone', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '14155550123', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('ignores low score for local unsaved and for saved foreign', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
    assert.deepEqual(
      decideIncomingAction(low, '14155550123', true, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('ignores unknown for unsaved non-local and local unsaved', () => {
    const unknown = scoreResult({ score: 25, label: 'unknown', ok: false });
    assert.deepEqual(
      decideIncomingAction(unknown, '447911123456', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
    assert.deepEqual(
      decideIncomingAction(unknown, '85261234567', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('ignores unknown when LID digits are missing', () => {
    const unknown = scoreResult({ score: 0, label: 'unknown', ok: false });
    assert.deepEqual(
      decideIncomingAction(unknown, null, false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('primary action stays archive; unsaved high-risk is blocked afterwards', () => {
    const high = scoreResult({ score: 99, label: 'scam' });
    const heuristic = { hit: true, id: 'otp_harvest', archiveReason: 'obvious_scam' };
    const d = decideIncomingAction(high, '14155550123', false, heuristic);
    assert.equal(d.action, 'archive');
    const blocked = applyBlockPolicy(d, {
      savedContact: false,
      scoreResult: high,
      heuristic,
    });
    assert.equal(blocked.action, 'block');
    assert.equal(blocked.contactName, '封鎖·索取驗證碼');
  });

  it('archives optional RAG / local-classifier hits after heuristics', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: false }, {
        hit: true,
        archiveReason: 'rag_scam_match',
      }),
      { action: 'archive', archiveReason: 'rag_scam_match' },
    );
    assert.deepEqual(
      decideIncomingAction(
        low,
        '85261234567',
        true,
        { hit: false },
        { hit: false },
        { hit: true, archiveReason: 'local_classifier' },
      ),
      { action: 'archive', archiveReason: 'local_classifier' },
    );
  });
});

describe('resolveIncomingMessageLabel', () => {
  it('promotes heuristic to scam without changing jevlike fail-closed unknown otherwise', () => {
    const promoted = resolveIncomingMessageLabel(
      scoreResult({ label: 'not_scam', score: 2 }),
      'WhatsApp 官方通知：否則封號',
    );
    assert.equal(promoted.label, 'scam');
    assert.equal(promoted.archiveReason, 'obvious_scam');

    const unknown = resolveIncomingMessageLabel(
      scoreResult({ label: 'unknown', score: 0, ok: false }),
      'hello',
    );
    assert.equal(unknown.label, 'unknown');
    assert.equal(unknown.archiveReason, null);
  });
});

describe('scoring labels', () => {
  it('labels using archive / safe thresholds', () => {
    assert.equal(labelFromScore(42, rubric.thresholds), 'scam');
    assert.equal(labelFromScore(18, rubric.thresholds), 'not_scam');
    assert.equal(labelFromScore(25, rubric.thresholds), 'unknown');
    assert.equal(labelFromScore(99, rubric.thresholds, { ok: false }), 'unknown');
    assert.equal(labelFromScore(99, rubric.thresholds, { empty: true }), 'unknown');
  });
});

describe('scoreMessage with stub jevlike', () => {
  it('skips empty text as unknown without calling the client', async () => {
    let called = 0;
    const client = {
      async scoreText() {
        called += 1;
        return { prob_scam: 0.9 };
      },
    };
    const result = await scoreMessage('   ', { client, rubric });
    assert.equal(called, 0);
    assert.equal(result.label, 'unknown');
    assert.equal(result.empty, true);
    assert.equal(result.ok, true);
    assert.equal(result.scorer, 'jevlike');
  });

  it('returns stub benign as not_scam', async () => {
    const result = await scoreMessage('今晚飲茶？', {
      client: createStubJevlikeClient('benign'),
      rubric,
    });
    assert.equal(result.ok, true);
    assert.equal(result.label, 'not_scam');
    assert.equal(result.scorer, 'jevlike');
  });

  it('returns stub scam as scam', async () => {
    const result = await scoreMessage('[stub:scam] 請立即轉帳', {
      client: createStubJevlikeClient(),
      rubric,
    });
    assert.equal(result.label, 'scam');
    assert.equal(result.archiveReason, 'jevlike_score');
    assert.ok(result.score >= rubric.thresholds.archive);
  });

  it('keeps a usable mask URL and timeout', () => {
    assert.equal(
      resolveMaskUrl('http://127.0.0.1:8766/v1/score'),
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

  it('fails closed on timeout / 5xx / invalid JSON', async () => {
    const timeoutClient = {
      async scoreText() {
        throw new Error('jevlike timeout');
      },
    };
    const a = await scoreMessage('hello', { client: timeoutClient, rubric });
    assert.equal(a.label, 'unknown');
    assert.equal(a.ok, false);
    assert.equal(a.reason, 'jevlike_error');

    const fetch500 = async () =>
      new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
    const client500 = new JevlikeClient({
      baseURL: 'http://127.0.0.1:9',
      apiKey: 'test',
      fetchImpl: fetch500,
      timeoutMs: 500,
    });
    const b = await scoreMessage('hello', { client: client500, rubric });
    assert.equal(b.label, 'unknown');
    assert.equal(b.ok, false);

    const badJson = async () =>
      new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });
    const clientBad = new JevlikeClient({
      baseURL: 'http://jevlike.test',
      fetchImpl: badJson,
    });
    const c = await scoreMessage('hello', { client: clientBad, rubric });
    assert.equal(c.label, 'unknown');
    assert.equal(c.ok, false);
  });

  it('retries once on 429 then succeeds', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n === 1) {
        return new Response('slow down', { status: 429 });
      }
      return createStubJevlikeFetch(PRESETS.scam)();
    };
    const client = new JevlikeClient({
      baseURL: 'http://jevlike.test',
      fetchImpl,
      timeoutMs: 1000,
    });
    const out = await client.scoreText('x');
    assert.equal(n, 2);
    assert.ok(out.prob_scam > 0.9);
  });
});

describe('cache', () => {
  it('expires entries after TTL', () => {
    let now = 1000;
    const cache = new TtlCache({ ttlMs: 50, now: () => now });
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
    now = 1060;
    assert.equal(cache.get('a'), undefined);
  });

  it('keys on message id + text hash', () => {
    const a = cacheKeyForMessage('id1', 'hello');
    const b = cacheKeyForMessage('id1', 'hello');
    const c = cacheKeyForMessage('id1', 'other');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('processIncomingMessage', () => {
  it('skips groups before scoring', async () => {
    let scored = false;
    const out = await processIncomingMessage(
      { isGroup: true, body: 'hi', chatId: 'g' },
      {
        scoreClient: {
          async scoreText() {
            scored = true;
            return {};
          },
        },
        rubric,
      },
    );
    assert.equal(out.ignored, true);
    assert.equal(scored, false);
  });

  it('archives via callback on high stub score', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即把驗證碼發給我並轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'm1',
      },
      {
        scoreClient: createStubJevlikeClient('scam'),
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => {
          reasons.push(reason);
        },
      },
    );
    assert.equal(out.ignored, false);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'jevlike_score');
    assert.deepEqual(reasons, ['jevlike_score']);
  });

  it('does not archive fail-closed unknown for local unsaved', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'hello',
        chatId: '852@c.us',
        savedContact: false,
      },
      {
        scoreClient: {
          async scoreText() {
            throw new Error('jevlike timeout');
          },
        },
        rubric,
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.scoreResult.label, 'unknown');
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('does not archive an unsaved non-local number on a clean low score', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: 'Hi',
        chatId: '14155550123@c.us',
        savedContact: false,
        messageId: 'foreign-hi',
      },
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({
          digits: '14155550123',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.equal(out.decision.archiveReason, null);
    assert.deepEqual(reasons, []);
  });
});
