'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractDigits,
  isLocalDial,
  isNonLocalDial,
} = require('./lib/foreign-number');
const { isLidId, lidUserPart, phoneFromLidMapping, resolveRealNumber } = require('./lib/lid');
const { shouldIgnoreMessage, isOfficialWhatsAppName } = require('./lib/filters');
const { matchObviousScam } = require('./lib/heuristics');
const { decideIncomingAction, resolveIncomingMessageLabel } = require('./lib/decide-incoming');
const {
  loadRubric,
  applyNoiseFloor,
  aggregateScores,
  labelFromScore,
  scoreMessage,
  questionsFromRubric,
} = require('./lib/score-message');
const { LightJevClient, questionsToRecords, resultsToAnswers } = require('./lib/lightjev-client');
const { processIncomingMessage, startupForeignArchive, pickSidebarOneToOne } = require('./lib/handle-incoming');
const { TtlCache, cacheKeyForMessage } = require('./lib/cache');
const {
  createStubClient,
  createStubFetch,
  PRESETS,
  noulMapToAnswers,
} = require('./stub-lightjev');

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

describe('foreign-number', () => {
  it('strips plus, spaces, and 00 prefix', () => {
    assert.equal(extractDigits('+852 6123 4567'), '85261234567');
    assert.equal(extractDigits('00886123456789'), '886123456789');
  });

  it('treats 852 / 86 / 886 as local', () => {
    assert.equal(isLocalDial('85261234567'), true);
    assert.equal(isLocalDial('+86 138 0000 0000'), true);
    assert.equal(isLocalDial('886912345678'), true);
    assert.equal(isNonLocalDial('85261234567'), false);
  });

  it('does not treat 886 as China-only; it is still local TW', () => {
    assert.equal(isLocalDial('886233112345'), true);
  });

  it('excludes 880–883 and 888 from CN/local', () => {
    assert.equal(isLocalDial('8801712345678'), false);
    assert.equal(isLocalDial('881123456'), false);
    assert.equal(isLocalDial('882123456'), false);
    assert.equal(isLocalDial('883123456'), false);
    assert.equal(isLocalDial('888123456'), false);
    assert.equal(isNonLocalDial('8801712345678'), true);
  });

  it('treats US / UK as non-local', () => {
    assert.equal(isNonLocalDial('14155550123'), true);
    assert.equal(isNonLocalDial('447911123456'), true);
  });

  it('does not mark empty / missing as non-local (cannot apply foreign rule)', () => {
    assert.equal(isNonLocalDial(''), false);
    assert.equal(isNonLocalDial(null), false);
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
  it('ignores fromMe, groups, notifications, isMe, and official WhatsApp names', () => {
    assert.equal(shouldIgnoreMessage({ fromMe: true }).ignore, true);
    assert.equal(shouldIgnoreMessage({ isGroup: true }).ignore, true);
    assert.equal(shouldIgnoreMessage({ isMe: true }).ignore, true);
    assert.equal(shouldIgnoreMessage({ type: 'notification' }).ignore, true);
    assert.equal(shouldIgnoreMessage({ type: 'e2e_notification' }).reason, 'notification');
    assert.equal(
      shouldIgnoreMessage({ contactName: 'WhatsApp' }).reason,
      'official_whatsapp',
    );
    assert.equal(
      shouldIgnoreMessage({ pushName: 'WhatsApp Business' }).reason,
      'official_whatsapp',
    );
    assert.equal(
      shouldIgnoreMessage({ contactName: 'WhatsApp 官方' }).reason,
      'official_whatsapp',
    );
    assert.equal(isOfficialWhatsAppName('Alice'), false);
    assert.equal(shouldIgnoreMessage({ type: 'chat' }).ignore, false);
  });
});

describe('heuristics', () => {
  it('matches tight OTP / FPS / official-ban / USDT / SF tropes', () => {
    assert.equal(
      matchObviousScam('您的驗證碼即將過期，請立即回覆').hit,
      true,
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
      { action: 'archive', archiveReason: 'lightjev_score' },
    );
    assert.deepEqual(
      decideIncomingAction(high, '14155550123', false, { hit: true }),
      { action: 'archive', archiveReason: 'lightjev_score' },
    );
  });

  it('archives on obvious heuristic even when score is low', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: true }),
      { action: 'archive', archiveReason: 'obvious_scam' },
    );
  });

  it('archives unsaved non-local on low score without heuristic', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '14155550123', false, { hit: false }),
      { action: 'archive', archiveReason: 'foreign_number' },
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

  it('archives unknown + unsaved non-local; ignores unknown local unsaved', () => {
    const unknown = scoreResult({ score: 25, label: 'unknown', ok: false });
    assert.deepEqual(
      decideIncomingAction(unknown, '447911123456', false, { hit: false }),
      { action: 'archive', archiveReason: 'foreign_number' },
    );
    assert.deepEqual(
      decideIncomingAction(unknown, '85261234567', false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('does not apply foreign rule when LID is unresolved (null digits)', () => {
    const unknown = scoreResult({ score: 0, label: 'unknown', ok: false });
    assert.deepEqual(
      decideIncomingAction(unknown, null, false, { hit: false }),
      { action: 'ignore', archiveReason: null },
    );
  });

  it('never returns block', () => {
    const high = scoreResult({ score: 99, label: 'scam' });
    const d = decideIncomingAction(high, '14155550123', false, { hit: true });
    assert.equal(d.action, 'archive');
    assert.notEqual(d.action, 'block');
  });

  it('archives on local classifier overlay when LightJev and heuristic miss', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: false }, {
        hit: true,
        archiveReason: 'local_classifier_scam',
        prob_scam: 0.99,
      }),
      { action: 'archive', archiveReason: 'local_classifier_scam' },
    );
  });

  it('keeps LightJev / heuristic ahead of the classifier overlay', () => {
    const high = scoreResult({ score: 50, label: 'scam' });
    assert.deepEqual(
      decideIncomingAction(high, '85261234567', true, { hit: true }, {
        classifier: { hit: true, archiveReason: 'local_classifier_scam' },
      }),
      { action: 'archive', archiveReason: 'lightjev_score' },
    );
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: true }, {
        classifier: { hit: true, archiveReason: 'local_classifier_scam' },
      }),
      { action: 'archive', archiveReason: 'obvious_scam' },
    );
  });

  it('does not archive from a fail-open classifier miss', () => {
    const low = scoreResult({ score: 4, label: 'not_scam' });
    assert.deepEqual(
      decideIncomingAction(low, '85261234567', true, { hit: false }, {
        ok: false,
        hit: false,
        reason: 'timeout',
      }),
      { action: 'ignore', archiveReason: null },
    );
  });
});

describe('resolveIncomingMessageLabel', () => {
  it('promotes heuristic to scam without changing LightJev fail-closed unknown otherwise', () => {
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

  it('promotes local classifier overlay after LightJev and heuristic miss', () => {
    const promoted = resolveIncomingMessageLabel(
      scoreResult({ label: 'not_scam', score: 2 }),
      '今晚食飯',
      {},
      { hit: true, archiveReason: 'local_classifier_scam', prob_scam: 0.99 },
    );
    assert.equal(promoted.label, 'scam');
    assert.equal(promoted.archiveReason, 'local_classifier_scam');
  });
});

describe('scoring aggregation', () => {
  it('applies noise floor so weak probabilities contribute 0', () => {
    assert.equal(applyNoiseFloor(0.2, 0.45), 0);
    assert.equal(applyNoiseFloor(0.45, 0.45), 0);
    assert.ok(Math.abs(applyNoiseFloor(1, 0.45) - 1) < 1e-9);
  });

  it('labels using archive / safe thresholds', () => {
    assert.equal(labelFromScore(42, rubric.thresholds), 'scam');
    assert.equal(labelFromScore(18, rubric.thresholds), 'not_scam');
    assert.equal(labelFromScore(25, rubric.thresholds), 'unknown');
    assert.equal(labelFromScore(99, rubric.thresholds, { ok: false }), 'unknown');
    assert.equal(labelFromScore(99, rubric.thresholds, { empty: true }), 'unknown');
  });

  it('does not archive on urgency alone', () => {
    const answers = noulMapToAnswers({
      ...PRESETS.benign,
      urgency: 1,
    });
    const agg = aggregateScores(answers, rubric);
    const label = labelFromScore(agg.score, rubric.thresholds);
    assert.ok(agg.score < rubric.thresholds.archive);
    assert.equal(label, 'not_scam');
  });

  it('archives a clear OTP + bank + impersonation DM', () => {
    const agg = aggregateScores(noulMapToAnswers(PRESETS.scam), rubric);
    assert.ok(agg.score >= rubric.thresholds.archive);
    assert.ok(agg.bonus === 12);
    assert.equal(labelFromScore(agg.score, rubric.thresholds), 'scam');
  });

  it('builds one noul question per dimension', () => {
    const q = questionsFromRubric(rubric);
    assert.equal(Object.keys(q).length, rubric.dimensions.length);
    assert.equal(q.money.type, 'noul');
    assert.equal(q.login_ato.type, 'noul');
  });

  it('caps state length for LightJev 256-token inputs', () => {
    assert.ok(rubric.maxStateChars <= 256);
  });
});

describe('scoreMessage with stub LightJev', () => {
  it('skips empty text as unknown without calling the client', async () => {
    let called = 0;
    const client = {
      async systemOne() {
        called += 1;
        return {};
      },
    };
    const result = await scoreMessage('   ', { client, rubric });
    assert.equal(called, 0);
    assert.equal(result.label, 'unknown');
    assert.equal(result.empty, true);
    assert.equal(result.ok, true);
  });

  it('returns stub benign as not_scam', async () => {
    const result = await scoreMessage('今晚飲茶？', {
      client: createStubClient('benign'),
      rubric,
    });
    assert.equal(result.ok, true);
    assert.equal(result.label, 'not_scam');
  });

  it('returns stub scam as scam with breakdown', async () => {
    const result = await scoreMessage('[stub:scam] 請立即轉帳', {
      client: createStubClient('scam'),
      rubric,
    });
    assert.equal(result.label, 'scam');
    assert.ok(result.breakdown.length === rubric.dimensions.length);
    assert.ok(result.score >= rubric.thresholds.archive);
  });

  it('fails closed on timeout / 5xx / invalid JSON', async () => {
    const timeoutClient = {
      async systemOne() {
        throw new Error('LightJev timeout');
      },
    };
    const a = await scoreMessage('hello', { client: timeoutClient, rubric });
    assert.equal(a.label, 'unknown');
    assert.equal(a.ok, false);

    const fetch500 = async () =>
      new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
    const client500 = new LightJevClient({
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
    const clientBad = new LightJevClient({
      baseURL: 'http://lightjev.test',
      fetchImpl: badJson,
    });
    const c = await scoreMessage('hello', { client: clientBad, rubric });
    assert.equal(c.label, 'unknown');
    assert.equal(c.ok, false);
  });

  it('LightJevClient maps noul questions to boolean records and parses /predict', async () => {
    const client = new LightJevClient({
      baseURL: 'http://lightjev.test',
      apiKey: 'stub',
      fetchImpl: createStubFetch('scam'),
    });
    const answers = await client.systemOne({
      state: 'x',
      questions: questionsFromRubric(rubric),
    });
    assert.equal(answers.money.noul, PRESETS.scam.money);
  });

  it('maps boolean probabilities[1] to noul', () => {
    const answers = resultsToAnswers([
      {
        id: 'money',
        kind: 'boolean',
        candidates: ['false', 'true'],
        probabilities: [0.1, 0.9],
        selected: 'true',
        selected_index: 1,
      },
    ]);
    assert.equal(answers.money.noul, 0.9);
    assert.equal(answers.money.type, 'noul');
  });

  it('encodes noul rubric questions as LightJev boolean records', () => {
    const records = questionsToRecords('hi', questionsFromRubric(rubric), 'm1');
    assert.equal(records.length, rubric.dimensions.length);
    assert.ok(records.every((row) => row.kind === 'boolean'));
    assert.deepEqual(records[0].candidates, ['false', 'true']);
    assert.equal(records[0].state, 'hi');
    assert.equal(records[0].group_id, 'm1');
  });

  it('retries once on 429 then succeeds', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n === 1) {
        return new Response('slow down', { status: 429 });
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'money',
              kind: 'boolean',
              candidates: ['false', 'true'],
              probabilities: [0.9, 0.1],
              selected: 'false',
              selected_index: 0,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const client = new LightJevClient({
      baseURL: 'http://lightjev.test',
      fetchImpl,
      timeoutMs: 1000,
    });
    const answers = await client.systemOne({
      state: 'x',
      questions: { money: { type: 'noul', instructions: 'q' } },
    });
    assert.equal(n, 2);
    assert.equal(answers.money.noul, 0.1);
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
          async systemOne() {
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
        scoreClient: createStubClient('scam'),
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
    assert.equal(out.decision.archiveReason, 'lightjev_score');
    assert.deepEqual(reasons, ['lightjev_score']);
  });

  it('keeps LightJev archive when the classifier also hits', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '請立即把驗證碼發給我並轉帳',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'm-both',
      },
      {
        scoreClient: createStubClient('scam'),
        rubric,
        env: { SCAM_CLASSIFIER_ENABLED: 'true', SCAM_CLASSIFIER_THRESH: '0.85' },
        classifierFetch: async () =>
          new Response(JSON.stringify({ label: 'scam', prob_scam: 0.99 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.decision.archiveReason, 'lightjev_score');
    assert.equal(out.classifier.hit, true);
    assert.deepEqual(reasons, ['lightjev_score']);
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
          async systemOne() {
            throw new Error('LightJev timeout');
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

  it('archives via local classifier when LightJev is low and heuristic misses', async () => {
    const reasons = [];
    let classifierCalls = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '細佬幫我轉數快三千，新號唔好打',
        chatId: '85261234567@c.us',
        savedContact: true,
        messageId: 'm-clf',
      },
      {
        scoreClient: createStubClient('benign'),
        rubric,
        env: {
          SCAM_CLASSIFIER_ENABLED: 'true',
          SCAM_CLASSIFIER_THRESH: '0.85',
        },
        classifierFetch: async () => {
          classifierCalls += 1;
          return new Response(
            JSON.stringify({ label: 'scam', prob_scam: 0.9994 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(classifierCalls, 1);
    assert.equal(out.classifier.hit, true);
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'local_classifier_scam');
    assert.deepEqual(reasons, ['local_classifier_scam']);
  });

  it('does not call the classifier when disabled (default)', async () => {
    let classifierCalls = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '細佬幫我轉數快三千',
        chatId: '852@c.us',
        savedContact: true,
      },
      {
        scoreClient: createStubClient('benign'),
        rubric,
        env: {},
        classifierFetch: async () => {
          classifierCalls += 1;
          return new Response('{}', { status: 200 });
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
      },
    );
    assert.equal(classifierCalls, 0);
    assert.equal(out.classifier.reason, 'disabled');
    assert.equal(out.decision.action, 'ignore');
  });

  it('fail-opens when the classifier HTTP endpoint is down', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '細佬幫我轉數快三千',
        chatId: '852@c.us',
        savedContact: true,
      },
      {
        scoreClient: createStubClient('benign'),
        rubric,
        env: { SCAM_CLASSIFIER_ENABLED: 'true' },
        classifierFetch: async () => {
          throw new Error('ECONNREFUSED');
        },
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.classifier.hit, false);
    assert.equal(out.classifier.ok, false);
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('suppresses high-prob scam-news instead of archiving', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '新聞話而家好多假警察騙案，叫人轉保證金，大家小心啲。',
        chatId: '852@c.us',
        savedContact: true,
      },
      {
        scoreClient: createStubClient('benign'),
        rubric,
        env: { SCAM_CLASSIFIER_ENABLED: 'true', SCAM_CLASSIFIER_THRESH: '0.85' },
        classifierFetch: async () =>
          new Response(JSON.stringify({ label: 'scam', prob_scam: 0.9934 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.classifier.suppressed, 'scam_news');
    assert.equal(out.classifier.hit, false);
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(reasons, []);
  });

  it('archives otp-forward combo even when the model probability is low', async () => {
    const reasons = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '哈哈你啱啱收到個code係我搞錯，可唔可以copy過嚟畀我呀？唔該晒。',
        chatId: '852@c.us',
        savedContact: true,
      },
      {
        scoreClient: createStubClient('benign'),
        rubric,
        env: { SCAM_CLASSIFIER_ENABLED: 'true', SCAM_CLASSIFIER_THRESH: '0.85' },
        classifierFetch: async () =>
          new Response(JSON.stringify({ label: 'not_scam', prob_scam: 0.0084 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        resolveNumber: async () => ({
          digits: '85261234567',
          unresolvedLid: false,
        }),
        archiveChat: async (reason) => reasons.push(reason),
      },
    );
    assert.equal(out.classifier.combo, 'otp_forward_ask');
    assert.equal(out.decision.archiveReason, 'local_classifier_scam');
    assert.deepEqual(reasons, ['local_classifier_scam']);
  });
});

describe('startup foreign scan', () => {
  it('takes the first 10 1:1 chats in sidebar order', () => {
    const chats = [
      { id: '1', isGroup: false },
      { id: 'g', isGroup: true },
      ...Array.from({ length: 12 }, (_, i) => ({ id: String(i + 2), isGroup: false })),
    ];
    const top = pickSidebarOneToOne(chats, 10);
    assert.equal(top.length, 10);
    assert.equal(top[0].id, '1');
    assert.ok(top.every((c) => !c.isGroup));
  });

  it('archives only unsaved non-local, no scoring', async () => {
    const archived = [];
    const n = await startupForeignArchive(
      [
        {
          chatId: 'a',
          savedContact: false,
          nonLocal: true,
          unresolvedLid: false,
          digits: '14155550123',
        },
        {
          chatId: 'b',
          savedContact: true,
          nonLocal: true,
          unresolvedLid: false,
          digits: '14155550124',
        },
        {
          chatId: 'c',
          savedContact: false,
          nonLocal: false,
          unresolvedLid: false,
          digits: '85261234567',
        },
        {
          chatId: 'd',
          savedContact: false,
          nonLocal: true,
          unresolvedLid: true,
          digits: null,
        },
      ],
      {
        archiveChat: async (chat) => {
          archived.push(chat.chatId);
        },
        logFn: { ok() {} },
      },
    );
    assert.equal(n, 1);
    assert.deepEqual(archived, ['a']);
  });
});
