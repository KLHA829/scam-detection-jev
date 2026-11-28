'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMON_TLDS,
  extractUrlCandidates,
  extractUrls,
  officialHosts,
  matchLinkScam,
  matchObviousScam,
} = require('./link-rules');
const { resetMaliciousHostsCache, reloadMaliciousHosts, loadMaliciousHosts, matchMaliciousHostInText } = require('./malicious-hosts');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

describe('link rules', () => {
  it('routes curated malicious hosts (warnings and lures) through masked LLM review without leaking raw hostnames', async () => {
    const { primaryPathDeps, notScamLlmFetch, scamLlmFetch, llmChatResponse } = require('./test-llm');
    const warnings = [
      '慎防詐騙短訊 wsd-gov.com，切勿打開',
      'Update: Fake SMS going around with wsd-gov.com. Do not visit.',
      '小心假短訊：「請登入 https://wsd-gov.com/pay」，係假㗎',
      '【防騙提示】最近有騙徒假冒惠康網站 wellcome-hk.com 呃人買平嘢，千祈唔好撳入去！',
      '小心假網站 https://wsd-gov.com。若已轉發短訊，請更改密碼。',
      '小心假網站 https://wsd-gov.com。騙徒叫佢提供重設驗證碼，大家小心。',
      '小心假網站 https://wsd-gov.com，切勿隨意按此登入。',
      '小心假網站 https://wsd-gov.com，不要拖延聯絡銀行以免騙徒轉帳到其他戶口。',
      '小心假網站 https://wsd-gov.com，騙徒利用假網頁騙取付款。',
      'HKCERT alert: Fake Wellcome site wellcome-hk.com is offering too-good-to-be-true deals. Do not enter your card details.',
    ];
    for (const body of warnings) {
      const hit = matchLinkScam(body);
      assert.equal(hit.hit, true, body);
      assert.equal(hit.id, 'malicious_host', body);
      assert.equal(hit.archiveReason, null, body);
      for (const savedContact of [false, true]) {
        for (const context of [false, true]) {
          const calls = [];
          let capturedBody = null;
          const out = await processIncomingMessage(
            { type: 'chat', body, chatId: 'warning@c.us', savedContact },
            primaryPathDeps({
              env: {
                CONTEXT_LLM_ENABLED: String(context),
                LLM_REVIEW_COOLDOWN_MS: '0',
                LLM_REVIEW_MIN_CONFIDENCE: '0.7',
                BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
              },
              contextLlm: { enabled: context },
              maskClient: {
                maskMessages: async (messages) => {
                  calls.push('mask');
                  return createStubJevlikeClient().maskMessages(messages);
                },
              },
              fetchImpl: async (_url, opts) => {
                calls.push('llm');
                capturedBody = JSON.parse(opts.body);
                return context
                  ? llmChatResponse({ action: 'no_action', confidence: 0.9 })()
                  : notScamLlmFetch()();
              },
              archiveChat: async () => calls.push('archive'),
              blockContact: async () => {
                calls.push('block');
                return { renamed: true, blocked: true, muted: true, errors: [] };
              },
            }),
          );
          assert.equal(out.decision.action, 'ignore', body);
          assert.deepEqual(calls, ['mask', 'llm'], body);
          const sys = capturedBody.messages.find((m) => m.role === 'system').content;
          const usr = capturedBody.messages.find((m) => m.role === 'user').content;
          assert.match(sys, /confirmed malicious-host list/i);
          assert.equal(sys.includes(hit.matchedHost), false, 'system prompt must not leak raw hostname');
          assert.equal(usr.includes(hit.matchedHost), false, 'user prompt must not leak raw hostname');
          assert.match(usr, /XXX/);
        }
      }
    }

    // Confirmed lures with a curated malicious URL block unsaved contacts and defer saved contacts.
    const lures = [
      '請登入 https://wsd-gov.com 付款',
      '假網站 https://wsd-gov.com。別再等 即時按此登入。',
      '小心假網站，本行要求大家按此登入 https://wsd-gov.com',
      '假網站 https://wsd-gov.com。收到驗證碼後，請回覆。',
    ];
    for (const body of lures) {
      for (const savedContact of [false, true]) {
        for (const context of [false, true]) {
          const calls = [];
          const out = await processIncomingMessage(
            { type: 'chat', body, chatId: 'lure@c.us', savedContact },
            primaryPathDeps({
              env: {
                CONTEXT_LLM_ENABLED: String(context),
                LLM_REVIEW_COOLDOWN_MS: '0',
                LLM_REVIEW_MIN_CONFIDENCE: '0.7',
                BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
              },
              contextLlm: { enabled: context },
              maskClient: {
                maskMessages: async (messages) => {
                  calls.push('mask');
                  return createStubJevlikeClient().maskMessages(messages);
                },
              },
              fetchImpl: async () => {
                calls.push('llm');
                // Intentionally set strong: false in context mode to verify curated host acts on first contact.
                return context
                  ? llmChatResponse({ action: 'archive', strong: false, confidence: 0.9 })()
                  : scamLlmFetch()();
              },
              archiveChat: async () => calls.push('archive'),
              blockContact: async () => {
                calls.push('block');
                return { renamed: true, blocked: true, muted: true, errors: [] };
              },
              recordBlock: async () => {},
            }),
          );
          if (savedContact) {
            assert.equal(out.decision.action, 'archive', body);
            assert.equal(out.deferred, true, body);
            assert.deepEqual(calls, ['mask', 'llm'], body);
          } else {
            assert.equal(out.decision.action, 'block', body);
            assert.equal(out.decision.blockReason, 'malicious_host', body);
            assert.deepEqual(calls, ['mask', 'llm', 'block', 'archive'], body);
          }
        }
      }
    }

    // Confirmed malicious email domain archives without auto-blocking and carries email note.
    let emailSys = '';
    const emailCalls = [];
    const emailOut = await processIncomingMessage(
      { type: 'chat', body: '請聯絡 support@hutong.biz', chatId: 'email-lure@c.us', savedContact: false },
      primaryPathDeps({
        env: { CONTEXT_LLM_ENABLED: 'true', LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient(),
        fetchImpl: async (_url, opts) => {
          emailSys = JSON.parse(opts.body).messages.find((m) => m.role === 'system').content;
          return llmChatResponse({ action: 'archive', strong: false, confidence: 0.9 })();
        },
        archiveChat: async () => emailCalls.push('archive'),
        blockContact: async () => {
          emailCalls.push('block');
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
      }),
    );
    assert.equal(emailOut.heuristic.id, 'malicious_email_host');
    assert.equal(emailOut.decision.action, 'archive');
    assert.deepEqual(emailCalls, ['archive']);
    assert.match(emailSys, /email address on the operator's confirmed malicious-host list/i);
    assert.equal(emailSys.includes('hutong.biz'), false);
    assert.equal(String(emailOut.redacted || '').includes('hutong.biz'), false);

    // URL userinfo with commas/semicolons must preserve the real destination host.
    for (const sep of [',', ';']) {
      const listedUserinfo = `https://wsd-gov.com${sep}news@example.org/report`;
      assert.deepEqual(extractUrls(listedUserinfo).map((u) => u.hostname), ['example.org'], listedUserinfo);
      assert.equal(matchLinkScam(listedUserinfo).hit, false, listedUserinfo);

      const listedDest = `https://example.org${sep}news@wsd-gov.com`;
      assert.deepEqual(extractUrls(listedDest).map((u) => u.hostname), ['wsd-gov.com'], listedDest);
      assert.equal(matchLinkScam(listedDest).id, 'malicious_host', listedDest);
    }
    for (const glued of [
      'wsd-gov.com，切勿點擊',
      'https://wsd-gov.com，切勿點擊',
      'https://wsd-gov.com，請勿點擊/登入',
      'https://wsd-gov.com，切勿點擊，聯絡help@gmail.com',
    ]) {
      assert.equal(matchLinkScam(glued).id, 'malicious_host', glued);
    }
    assert.deepEqual(
      extractUrls('https://wsd-gov.com，切勿點擊，聯絡help@gmail.com').map((u) => u.hostname),
      ['wsd-gov.com', 'gmail.com'],
    );

    // Masking curated malicious hosts maps NFKC offsets back to original text accurately
    // without erasing adjacent warnings or shifting spans on balanced Unicode changes.
    const { maskOneForLlm } = require('./context-llm');
    const { curatedMaliciousSpans } = require('./link-rules');
    const { applyXxx } = require('./pii-xxx');
    assert.equal(maskOneForLlm('https://wsd-gov.com，請勿點擊…', []), 'XXX，請勿點擊…');
    assert.equal(maskOneForLlm('Cafe\u0301 https://wsd-gov.com o\u0301 …', []), 'Cafe\u0301 XXX o\u0301 …');
    assert.equal(maskOneForLlm('ㄱㅏ https://wsd-gov.com，請勿點擊', []), 'ㄱㅏ XXX，請勿點擊');
    assert.equal(maskOneForLlm('ㄱㅏㄱ https://wsd-gov.com，請勿點擊', []), 'ㄱㅏㄱ XXX，請勿點擊');
    assert.equal(maskOneForLlm('https://wsd-gov.com/ㄱㅏ/pay，請勿點擊', []), 'XXX，請勿點擊');
    assert.equal(maskOneForLlm('https://wsd-gov.com/path/ㄱㅏㄱ 切勿點擊', []), 'XXX 切勿點擊');
    assert.equal(maskOneForLlm('防騙提醒：假網站 https://wsd-gov.com/pay，切勿點擊。', []), '防騙提醒：假網站 XXX，切勿點擊。');
    assert.equal(maskOneForLlm('聯絡 "a，b"@hutong.biz 查詢', []), '聯絡 XXX 查詢');
    assert.equal(maskOneForLlm('ﬁ "support desk"@hutong.biz 切勿聯絡', []), 'ﬁ XXX 切勿聯絡');
    assert.equal(maskOneForLlm('ｈｔｔｐｓ：／／ｈｕｔｏｎｇ．ｂｉｚ查詢', []), 'XXX查詢');
    assert.equal(maskOneForLlm('睇 https://example.com/a', []), '睇 https://<URL_1>/a');
    assert.equal(maskOneForLlm('睇 bit.ly/abc', []), '睇 <URL_1>/abc');
    assert.equal(maskOneForLlm('PayMe 去 https://payme.hsbc', []), 'PayMe 去 https://payme.hsbc');
    assert.equal(
      applyXxx(
        '查看 net.hk。foo.example。test，請勿點擊',
        curatedMaliciousSpans('查看 net.hk。foo.example。test，請勿點擊', { hosts: ['example.test'] }),
      ),
      '查看 XXX，請勿點擊',
    );
    assert.deepEqual(
      extractUrls('查看 net.hk。foo.example。Please click').map((u) => u.hostname),
      ['net.hk.foo.example'],
    );

    assert.deepEqual(
      extractUrlCandidates('https://www.google.com/search?q=don’t+visit+wsd-gov.com').map((c) => c.url.hostname),
      ['www.google.com'],
    );
    for (const close of ['”', '’', '」', '』']) {
      assert.equal(extractUrlCandidates(`https://wsd-gov.com/pay${close}`)[0].url.pathname, '/pay');
    }
    assert.equal(matchLinkScam(null).hit, false);
    assert.equal(matchLinkScam('防騙提醒：小心假網站').hit, false);
  });

  it('fails closed when curated malicious-host masking fails', async () => {
    const { primaryPathDeps } = require('./test-llm');
    for (const context of [false, true]) {
      const calls = [];
      const out = await processIncomingMessage(
        { type: 'chat', body: '防騙：假網站 https://wsd-gov.com 切勿點擊', chatId: 'warning-fail@c.us', savedContact: false },
        primaryPathDeps({
          env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
          contextLlm: { enabled: context },
          maskClient: { maskMessages: async () => { throw new Error('mask failed'); } },
          fetchImpl: async () => { calls.push('llm'); throw new Error('unexpected'); },
          archiveChat: async () => calls.push('archive'),
          blockContact: async () => { calls.push('block'); },
        }),
      );
      assert.equal(out.decision.action, 'ignore');
      assert.deepEqual(calls, []);
    }
  });

  it('sends short-link advice and authority mentions to masked AI review', async () => {
    const { primaryPathDeps, notScamLlmFetch } = require('./test-llm');
    for (const body of [
      '銀行職員唔會叫你撳 bit.ly/xxx 呢類連結，小心',
      '银行职员不会叫你打开 tinyurl.com/xxx，小心诈骗',
      '切勿相信銀行職員要求你登入 bit.ly/xxx',
      '銀行職員提醒大家小心 bit.ly/xxx',
      'WhatsApp 官方不會叫你登入 bit.ly/xxx',
      '唔好相信 WhatsApp 官方要求你撳 bit.ly/xxx',
      '銀行職員的防騙教學 bit.ly/xxx',
      '收到「WhatsApp 官方：請登入 bit.ly/xxx」呢類訊息唔好信',
      '收到「WhatsApp 官方通知：請登入 bit.ly/xxx」呢類訊息唔好信',
    ]) {
      assert.equal(matchLinkScam(body).hit, false, body);
      const calls = [];
      const mask = createStubJevlikeClient('benign');
      const out = await processIncomingMessage(
        { type: 'chat', body, chatId: 'advice@c.us', savedContact: false },
        primaryPathDeps({
          env: { LLM_REVIEW_COOLDOWN_MS: '0' },
          maskClient: { maskMessages: async (messages) => {
            calls.push('mask');
            return mask.maskMessages(messages);
          } },
          fetchImpl: async (...args) => {
            calls.push('llm');
            return notScamLlmFetch()(...args);
          },
          archiveChat: async () => calls.push('archive'),
        }),
      );
      assert.equal(out.decision.action, 'ignore', body);
      assert.deepEqual(calls, ['mask', 'llm'], body);
    }
  });

  it('routes short links (including OTP, money, and impersonation text) directly to masked AI review', async () => {
    const { primaryPathDeps, notScamLlmFetch, scamLlmFetch, llmChatResponse } = require('./test-llm');
    for (const body of [
      '請提供驗證碼 https://bit.ly/fee',
      '請提供驗證碼 bit.ly/fee',
      '請提供驗證碼 help@bit.ly',
      '請立即轉帳到此戶口 https://tinyurl.com/pay',
      '請轉帳 https://bit.ly/x',
      '請提供驗證碼 ｂｉｔ．ｌｙ／ｆｅｅ',
      '我係銀行職員，請撳 bit.ly/xxx 核實戶口',
      'WhatsApp 官方：請登入 bit.ly/xxx',
      '媽，麻煩幫我轉帳交學校旅行費，學校通知喺呢個連結 https://bit.ly/trip-notice',
      '請提供驗證碼 not-bit.ly/fee',
      'https://not-hangseng.evil.com/a',
      'https://my-whatsapp.example.com/a',
      'https://user:whatsapp@gmail.com/inbox',
    ]) assert.equal(matchLinkScam(body).hit, false, body);
    assert.equal(matchLinkScam('').hit, false);

    const familyFee = '媽，麻煩幫我轉帳交學校旅行費，學校通知喺呢個連結 https://bit.ly/trip-notice';
    for (const context of [undefined, '0']) {
      for (const savedContact of [true, false]) {
        for (const isScam of [false, true]) {
          const calls = [];
          const verdict = context === '0'
            ? (isScam ? scamLlmFetch() : notScamLlmFetch())
            : llmChatResponse({ action: isScam ? 'archive' : 'no_action', confidence: 0.9 });
          const mask = createStubJevlikeClient();
          const out = await processIncomingMessage(
            { type: 'chat', body: familyFee, chatId: 'family-fee@c.us', savedContact },
            primaryPathDeps({
              env: {
                CONTEXT_LLM_ENABLED: context,
                HEURISTIC_ENABLED: '1',
                LLM_REVIEW_MIN_CONFIDENCE: '0.7',
                LLM_REVIEW_COOLDOWN_MS: '0',
                BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
              },
              maskClient: {
                maskMessages: async (messages) => {
                  calls.push('mask');
                  return mask.maskMessages(messages);
                },
              },
              fetchImpl: async (...args) => {
                calls.push('llm');
                return verdict(...args);
              },
              archiveChat: async () => calls.push('archive'),
              blockContact: async () => calls.push('block'),
            }),
          );
          assert.equal(out.heuristic.id, null);
          assert.equal(out.decision.action, isScam ? 'archive' : 'ignore');
          assert.equal(out.deferred, isScam && savedContact);
          assert.deepEqual(calls, isScam && !savedContact ? ['mask', 'llm', 'archive'] : ['mask', 'llm']);
        }
      }
    }
  });

  it('fails closed when masking short-link advice fails', async () => {
    const { primaryPathDeps } = require('./test-llm');
    const calls = [];
    const out = await processIncomingMessage(
      {
        type: 'chat', body: '銀行職員唔會叫你撳 bit.ly/xxx 呢類連結，小心',
        chatId: 'advice-mask-failure@c.us', savedContact: false,
      },
      primaryPathDeps({
        maskClient: { maskMessages: async () => { throw new Error('mask unavailable'); } },
        fetchImpl: async () => { calls.push('llm'); throw new Error('unexpected LLM'); },
        archiveChat: async () => calls.push('archive'),
      }),
    );
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(calls, []);
  });

  it('ignores domain-like URL contents but keeps separate hosts', async () => {
    for (const prefix of ['https://example.com', 'www.example.com', 'example.com', 'example.com:8080']) {
      for (const suffix of ['/?q=whatsapp-secure.xyz', '/#whatsapp-secure.xyz', '/go/next=whatsapp-secure.xyz', '/?q=https://whatsapp-secure.xyz', '/?q=www.whatsapp-secure.xyz', '/?ref=bit.ly/fee', '?ref=bit.ly', '#whatsapp-secure.xyz']) {
        const body = `請提供驗證碼 ${prefix}${suffix}`;
        assert.deepEqual(extractUrls(body).map((url) => url.hostname), [prefix.startsWith('www.') ? 'www.example.com' : 'example.com'], body);
        if (prefix.endsWith(':8080')) assert.equal(extractUrls(body)[0].port, '8080');
        assert.equal(matchObviousScam(body).hit, false, body);
        assert.equal(matchObviousScam(`${body} whatsapp-secure.xyz`).id, 'lookalike_domain');
      }
    }
    assert.deepEqual(extractUrls('').map((url) => url.hostname), []);
    assert.deepEqual(extractUrls('https://?q=hello').map((url) => url.hostname), []);
    const commaQuery = 'https://example.com/?q=a，whatsapp-secure.xyz';
    assert.deepEqual(extractUrls(commaQuery).map((url) => url.hostname), ['example.com']);
    assert.equal(matchObviousScam(commaQuery).hit, false);
    const chineseQuery = 'https://www.google.com/search?q=中文whatsapp-secure.xyz';
    assert.deepEqual(extractUrls(chineseQuery).map((url) => url.hostname), ['www.google.com']);
    assert.equal(matchObviousScam(chineseQuery).hit, false);
    const idnHost = 'https://中文.whatsapp-secure.xyz/x';
    assert.deepEqual(extractUrls(idnHost).map((url) => url.hostname), ['xn--fiq228c.whatsapp-secure.xyz']);
    assert.equal(matchObviousScam(idnHost).id, 'lookalike_domain');
    const ideographicHost = 'https://whatsapp-secure。xyz/login';
    assert.deepEqual(extractUrls(ideographicHost).map((url) => url.hostname), ['whatsapp-secure.xyz']);
    assert.equal(matchObviousScam(ideographicHost).id, 'lookalike_domain');
    assert.equal(matchObviousScam('請睇 example.com/?q=1。登入https://whatsapp-secure.xyz/login').id, 'lookalike_domain');
    const boundaryCases = [
      ['https://example.com/path。https://whatsapp-secure.xyz', ['example.com', 'whatsapp-secure.xyz']],
      ['【www.whatsapp-secure.xyz】', ['www.whatsapp-secure.xyz']],
      ['example.com/?q=(https://whatsapp-secure.xyz', ['example.com']],
    ];
    for (const [body, hosts] of boundaryCases) {
      assert.deepEqual(extractUrls(body).map((url) => url.hostname), hosts, body);
      assert.equal(
        matchMaliciousHostInText(body, { hosts: ['whatsapp-secure.xyz'] }).hit,
        hosts.some((host) => host.endsWith('whatsapp-secure.xyz')),
        body,
      );
    }
    const archives = [];
    const out = await processIncomingMessage(
      { type: 'chat', body: 'https://www.google.com/search?q=whatsapp-secure.xyz', chatId: 'query@c.us', savedContact: true },
      { env: { HEURISTIC_ENABLED: '1', LLM_REVIEW_ENABLED: 'false' }, archiveChat: async (reason) => archives.push(reason) },
    );
    assert.equal(out.decision.action, 'ignore');
    assert.deepEqual(archives, []);
  });

  it('keeps bare hosts as candidates and preserves extractUrls output', () => {
    const text = '登入 https://whatsapp-secure.com/login';
    const candidates = extractUrlCandidates(text);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].bare, false);
    assert.deepEqual(
      extractUrls(text).map((url) => url.href),
      candidates.map(({ url }) => url.href),
    );
    assert.ok(COMMON_TLDS.includes('com'));
    assert.ok(COMMON_TLDS.includes('quest'));
  });

  it('does not treat brand-looking bare text with uncommon TLDs as a lookalike', () => {
    for (const text of [
      '我email係 john.hsbc@gmail.com',
      '請睇附件 hsbc.pdf',
      '我用緊 WhatsApp.Web 好方便',
      'e.g. hsbc.Login',
    ]) {
      assert.equal(matchObviousScam(text).hit, false, text);
    }
  });

  it('still flags lookalikes on common TLDs and explicit URLs', () => {
    for (const text of [
      '去 hsbc.hk 睇下',
      'hsbc-secure.top',
      'whatsapp-verify.xyz/login',
      'https://hsbc.login',
      'www.hsbc.web',
      'support@hsbc-secure.com',
    ]) {
      assert.equal(matchObviousScam(text).id, 'lookalike_domain', text);
    }
  });

  it('does not flag allowlisted hosts, a bare short link, or a short link with bill-splitting', () => {
    assert.equal(matchLinkScam('https://wa.me/85261234567').hit, false);
    assert.equal(matchLinkScam('https://www.hsbc.com.hk/transfer').hit, false);
    assert.equal(matchLinkScam('https://payme.hsbc.com.hk/x').hit, false);
    assert.equal(matchLinkScam('https://www.sf-express.com/hk').hit, false);
    assert.equal(matchLinkScam('https://www.whatsapp.com/security').hit, false);
    assert.equal(matchLinkScam('https://www.hsbc.com/transfer').hit, false);
    assert.equal(matchLinkScam('https://chat.whatsapp.com/AbCdEf').hit, false);
    assert.equal(matchLinkScam('教學 https://bestwhatsapp.com/tips').hit, false);
    assert.equal(matchLinkScam('https://whatsapp-tips.medium.com/post').hit, false);
    assert.equal(matchLinkScam('https://hsb.com/login').hit, false);
    assert.equal(matchLinkScam('睇下 https://bit.ly/menu').hit, false);
    assert.equal(matchLinkScam('youtu.be/abc123').hit, false);
    assert.equal(matchLinkScam('請提供驗證碼 youtu.be/dQw4w9WgXcQ').hit, false);
    assert.equal(matchLinkScam('https://whatsapp.github.io/docs').hit, false);
    assert.equal(matchLinkScam('https://hsbc.medium.com/story').hit, false);
    assert.equal(matchLinkScam('https://payme.blogspot.com/x').hit, false);
    assert.equal(matchLinkScam('https://not-hangseng.com/a').hit, false);
    assert.equal(matchLinkScam('sf-express.com/hk').hit, false);
    assert.equal(
      matchLinkScam('今晚食飯嗎？我轉帳比你 AA https://bit.ly/menu').hit,
      false,
    );
    assert.equal(matchObviousScam('今晚食飯嗎？我轉帳比你 AA').hit, false);
  });

  for (const domain of ['hsbc.co.uk', 'hsbc.com.cn', 'hsbc.com.au', 'hsbc.com.sg']) {
    it(`sends official ${domain} links to masked AI review`, async () => {
      const { llmChatResponse, primaryPathDeps, notScamLlmFetch } = require('./test-llm');
      const contextFetch = llmChatResponse({ action: 'no_action' });
      const cases = [
        { body: `https://www.${domain}/`, savedContact: true, contextEnabled: undefined, llmFetch: contextFetch },
        { body: `https://www.${domain}/`, savedContact: false, contextEnabled: undefined, llmFetch: contextFetch },
        { body: domain, savedContact: false, contextEnabled: '0', llmFetch: notScamLlmFetch() },
      ];
      for (const { body, savedContact, contextEnabled, llmFetch } of cases) {
        const calls = [];
        const mask = createStubJevlikeClient('benign');
        const out = await processIncomingMessage(
          { type: 'chat', body, chatId: 'bank-link@c.us', savedContact },
          primaryPathDeps({
            env: {
              CONTEXT_LLM_ENABLED: contextEnabled,
              HEURISTIC_ENABLED: '1',
              LLM_REVIEW_COOLDOWN_MS: '0',
            },
            maskClient: { maskMessages: async (messages) => {
              calls.push('mask');
              return mask.maskMessages(messages);
            } },
            fetchImpl: async (...args) => {
              calls.push('llm');
              return llmFetch(...args);
            },
            archiveChat: async () => calls.push('archive'),
            blockContact: async () => calls.push('block'),
          }),
        );
        assert.deepEqual(
          { action: out.decision.action, calls },
          { action: 'ignore', calls: ['mask', 'llm'] },
          body,
        );
        assert.equal(out.llmReview?.ok, true, body);
      }
    });
  }

  it('still flags HSBC regional lookalikes on unrelated hosts', () => {
    for (const body of [
      'https://hsbc-support.co.uk/',
      'https://hsbc-support.com.sg/',
      'https://hsbc.co.uk.example.com/',
      'https://hsbc.com.sg.example.com/',
      'https://hsbc-support.com.cn/',
      'https://hsbc-support.com.au/',
      'https://hsbc.com.cn.example.com/',
      'https://hsbc.com.au.example.com/',
      'https://hsbc-supporthsbc.com.au/',
      'https://hsbc.com.cn@example.com/',
      'https://www.hsbc.com.au/ https://hsbc-support.com.au/',
    ]) {
      assert.equal(matchLinkScam(body).id, 'lookalike_domain', body);
    }
  });

  it('flags lookalike hosts, one-character misspellings, homoglyphs, and userinfo tricks', () => {
    assert.equal(matchLinkScam('https://whatsapp-secure.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://sf-express-hk.com/pay').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://whatspp.com/verify').id, 'lookalike_domain');
    assert.equal(
      matchLinkScam('https://whats\u0430pp.com/login').id,
      'lookalike_domain',
    );
    assert.equal(
      matchLinkScam('https://whatsapp.com@evil.com/login').id,
      'lookalike_domain',
    );
    assert.equal(matchLinkScam('https://whatspp.com.cn/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://whatspp.com.mo/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://whatspp@evil.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('登入 whatsapp-secure.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://hsbc.evil.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://whatsapp-secure.evil.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://whatspp.evil.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://sf-express-hk.evil.com/pay').id, 'lookalike_domain');
    assert.equal(matchLinkScam('https://user:pass@whatsapp.com@evil.com/login').id, 'lookalike_domain');
    assert.equal(matchLinkScam('ｈｔｔｐｓ：／／ｗｈａｔｓａｐｐ－ｓｅｃｕｒｅ．ｃｏｍ／ｌｏｇｉｎ').id, 'lookalike_domain');
  });

  it('prefers malicious_host over lookalike when both match (dual-hit block eligibility)', () => {
    resetMaliciousHostsCache();
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dual-hit-'));
    const file = require('path').join(dir, 'hosts.json');
    require('fs').writeFileSync(file, JSON.stringify({ hosts: ['whatsapp-secure.com'] }));
    const prevPath = process.env.MALICIOUS_HOSTS_PATH;
    try {
      process.env.MALICIOUS_HOSTS_PATH = file;
      reloadMaliciousHosts(undefined, process.env);
      const body = '登入 https://whatsapp-secure.com/login';
      const heuristic = matchLinkScam(body);
      assert.equal(heuristic.id, 'malicious_host');
      const { applyBlockPolicy } = require('./block-policy');
      const after = applyBlockPolicy(
        { action: 'archive', archiveReason: 'obvious_scam' },
        {
          savedContact: false,
          scoreResult: { score: 3, label: 'not_scam', ok: true, thresholds: rubric.thresholds },
          heuristic,
        },
      );
      assert.equal(after.action, 'block');
      assert.equal(after.blockReason, 'malicious_host');
    } finally {
      if (process.env.MALICIOUS_HOSTS_PATH === file) delete process.env.MALICIOUS_HOSTS_PATH;
      else if (prevPath !== undefined) process.env.MALICIOUS_HOSTS_PATH = prevPath;
      require('fs').rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
      loadMaliciousHosts();
    }
  });

  it('matches and blocks bare malicious hosts with uncommon TLDs', () => {
    resetMaliciousHostsCache();
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'bare-malicious-'));
    const file = require('path').join(dir, 'hosts.json');
    require('fs').writeFileSync(file, JSON.stringify({ hosts: ['scam-site.weird'] }));
    const prevPath = process.env.MALICIOUS_HOSTS_PATH;
    try {
      process.env.MALICIOUS_HOSTS_PATH = file;
      reloadMaliciousHosts(undefined, process.env);
      const heuristic = matchObviousScam('scam-site.weird');
      assert.equal(heuristic.id, 'malicious_host');
      const { applyBlockPolicy } = require('./block-policy');
      const after = applyBlockPolicy(
        { action: 'archive', archiveReason: 'obvious_scam' },
        {
          savedContact: false,
          scoreResult: { score: 3, label: 'not_scam', ok: true, thresholds: rubric.thresholds },
          heuristic,
        },
      );
      assert.equal(after.action, 'block');
      assert.equal(after.blockReason, 'malicious_host');
    } finally {
      if (process.env.MALICIOUS_HOSTS_PATH === file) delete process.env.MALICIOUS_HOSTS_PATH;
      else if (prevPath !== undefined) process.env.MALICIOUS_HOSTS_PATH = prevPath;
      require('fs').rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
      loadMaliciousHosts();
    }
  });

  it('archives an unsaved lookalike without auto-block when AI confirms', async () => {
    const { primaryPathDeps } = require('./test-llm');
    let blocked = false;
    const archives = [];
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '登入 https://whatsapp-secure.com/login',
        chatId: 'lookalike@c.us',
        savedContact: false,
        messageId: 'lookalike-1',
      },
      primaryPathDeps({
        env: { LLM_REVIEW_MIN_CONFIDENCE: '0.7' },
        maskClient: createStubJevlikeClient('benign'),
        resolveNumber: async () => ({ digits: '85260002222', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      }),
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'llm_review_scam');
    assert.equal(blocked, false);
    assert.deepEqual(archives, ['llm_review_scam']);
  });

  it('allowlists payme.hsbc and extracts full emails, CJK-glued, markdown, punycode, and ideographic hosts', () => {
    assert.equal(matchLinkScam('用 https://payme.hsbc/payme 交飯錢').hit, false);
    assert.equal(matchObviousScam('用 https://payme.hsbc/payme 交飯錢').hit, false);

    const emailCands = extractUrlCandidates('mail support-team-fake@hutong.biz');
    assert.equal(emailCands.length, 1);
    assert.equal(emailCands[0].email, true);
    assert.equal(emailCands[0].start, 5);
    assert.equal(emailCands[0].end, 33);
    assert.equal(matchObviousScam('聯絡 support-team-fake@hutong.biz').id, 'malicious_email_host');

    const cjkCands = extractUrlCandidates('https://hutong.biz查詢');
    assert.equal(cjkCands[0].url.hostname, 'hutong.biz');
    assert.equal(matchObviousScam('https://hutong.biz查詢').id, 'malicious_host');
    assert.equal(matchLinkScam('https://hsbc.com.hk查詢').hit, false);

    for (const wrapped of [
      '*https://hutong.biz*',
      '_https://hutong.biz_',
      '~https://hutong.biz~',
      '`https://hutong.biz`',
      '[https://hutong.biz]',
      '{https://hutong.biz}',
    ]) {
      const hit = matchObviousScam(wrapped);
      assert.equal(hit.id, 'malicious_host', wrapped);
      assert.equal(hit.matchedHost, 'hutong.biz', wrapped);
    }

    const punyCands = extractUrlCandidates('malicious.xn--j6w193g/login');
    assert.equal(punyCands.length, 1);
    assert.equal(punyCands[0].url.pathname, '/login');

    for (const ideographic of ['https://hutong。biz/a', 'hutong。biz']) {
      const hit = matchObviousScam(ideographic);
      assert.equal(hit.id, 'malicious_host', ideographic);
    }

    assert.equal(matchObviousScam('user@malicious-block-test.invalid/login').id, 'malicious_host');
    assert.equal(
      matchObviousScam('support@example.com?url=https://malicious-block-test.invalid').id,
      'malicious_host',
    );
    assert.equal(matchLinkScam('Fake site wsd-gov.com. Do not hesitate to log in now.').hit, true);
    assert.equal(matchLinkScam('Fake site hsbc-hk-secure.com. Do not hesitate to log in now.').hit, true);

    for (const mixed of [
      'https://hutong.biz香港.com/booking',
      'https://hutong.biz香港/booking',
    ]) {
      assert.equal(matchObviousScam(mixed).hit, false, mixed);
      assert.equal(matchLinkScam(mixed).hit, false, mixed);
    }

    for (const sentenceStop of [
      '請登入 https://hutong.biz。完成登記',
      '請登入 https://hutong.biz。Please click',
      '請登入 https://hutong.biz。Hi there',
      '請登入 https://hutong。biz。完成登記',
      '請登入 https://hutong。biz。Please click',
      '(https://hutong。biz)。完成登記',
      '_https://hutong。biz_。完成登記',
    ]) {
      const hit = matchObviousScam(sentenceStop);
      assert.equal(hit.id, 'malicious_host', sentenceStop);
      assert.equal(hit.matchedHost, 'hutong.biz', sentenceStop);
    }

    assert.deepEqual(
      extractUrls('請登入 https://hutong.biz。完成登記。example.com').map((url) => url.hostname),
      ['hutong.biz', 'example.com'],
    );
    assert.deepEqual(
      extractUrls('https://hutong.biz。https://whatsapp-secure.xyz').map((url) => url.hostname),
      ['hutong.biz', 'whatsapp-secure.xyz'],
    );

    for (const splitSafe of [
      ['https://hutong.biz。example.com/booking', 'hutong.biz.example.com'],
      ['https://hutong.biz。example.com', 'hutong.biz.example.com'],
      ['hutong.biz。example.com/booking', 'hutong.biz.example.com'],
      ['(https://hutong.biz。example.com)', 'hutong.biz.example.com'],
      ['https://hutong.biz。香港.com/booking', 'hutong.biz.xn--j6w193g.com'],
    ]) {
      const [body, expectedHost] = splitSafe;
      assert.deepEqual(extractUrls(body).map((url) => url.hostname), [expectedHost], body);
      assert.equal(matchObviousScam(body).hit, false, body);
      assert.equal(matchLinkScam(body).hit, false, body);
    }

    for (const [obfuscated, expectedHost] of [
      ['https://hutong。biz/a', 'hutong.biz'],
      ['https://hutong。biz查詢', 'hutong.biz'],
      ['*https://hutong。biz*', 'hutong.biz'],
      ['https://login。malicious-block-test。invalid/a', 'malicious-block-test.invalid'],
      ['https://a.login。malicious-block-test。invalid/a', 'malicious-block-test.invalid'],
      ['https://www-mpfa-org-hk。axm.info/', 'www-mpfa-org-hk.axm.info'],
      ['https://www-mpfa-org-hk。axm.info', 'www-mpfa-org-hk.axm.info'],
      ['*https://www-mpfa-org-hk。axm.info*', 'www-mpfa-org-hk.axm.info'],
      ['https://sub.www-mpfa-org-hk。axm.info/login', 'www-mpfa-org-hk.axm.info'],
    ]) {
      const hit = matchObviousScam(obfuscated);
      assert.equal(hit.id, 'malicious_host', obfuscated);
      assert.equal(hit.matchedHost, expectedHost, obfuscated);
    }
    assert.equal(matchLinkScam('https://hsbc.com。hk/login').hit, false);
    assert.equal(matchLinkScam('https://hsbc.com。hk').hit, false);
  });
});

describe('officialHosts', () => {
  const hosts = (text) => officialHosts(text).map(({ host }) => host);

  it('names brands\' own domains and leaves lookalikes and other domains out', () => {
    assert.deepEqual(hosts('PayMe 去呢個 link: https://payme.hsbc/repairmaster88'), ['payme.hsbc']);
    assert.deepEqual(hosts('https://payme.hsbc.com.hk/x 或 www.hsbc.com.hk'), ['payme.hsbc.com.hk', 'www.hsbc.com.hk']);
    assert.deepEqual(hosts('https://payme.hsbc.evil.com/a hsbc-secure.com/login https://example.com/a bit.ly/abc'), []);
  });

  it('locates every occurrence of the domain in the text', () => {
    const text = '去 https://payme.hsbc/a 或者 HTTPS://user@PayMe.HSBC:443/b';
    assert.deepEqual(officialHosts(text).map(({ start, end }) => text.slice(start, end)), ['payme.hsbc', 'PayMe.HSBC']);
    const after = '麻煩… ﬁ PayMe 去 https://payme.hsbc/a，chan@gmail.com ｶﾞ 50㎡';
    assert.deepEqual(officialHosts(after).map(({ start, end }) => after.slice(start, end)), ['payme.hsbc']);
  });

  it('leaves out a domain that normalising the text moved or rewrote', () => {
    assert.deepEqual(officialHosts('…https://payme.hsbc/a'), []);
    assert.deepEqual(officialHosts('https://payme。hsbc/a'), []);
  });

  it('does not count a brand domain inside a login, an email, another link or a longer name', () => {
    assert.deepEqual(hosts('whatsapp.com@evil.com/x'), []);
    assert.deepEqual(hosts('https://whatsapp.com@evil.com/x'), []);
    assert.deepEqual(hosts('payme.hsbc+chan@gmail.com 或 https://evil.com/payme.hsbc/x'), []);
    assert.deepEqual(hosts('https://payme.hsbc123/x 或 payme.hsbc123'), []);
    assert.deepEqual(hosts('https://payme.hsbc。x@evil.com/a 或 https://payme.hsbc。x:pw@evil.com'), []);
    assert.deepEqual(hosts('"chan payme.hsbc"@gmail.com 或 payme.hsbc。x@gmail.com'), []);
    assert.doesNotThrow(() => officialHosts('https://payme.hsbc(/x https://wa.me)/1'));
  });

  it('does not vouch when authority remnants hide inside a mask token', () => {
    assert.deepEqual(hosts('https://payme.hsbc/<PII_1>'), ['payme.hsbc']);
    assert.deepEqual(hosts('https://payme.hsbc./x'), ['payme.hsbc']);
    for (const redacted of [
      'https://payme.hsbc<PII_1>',
      'https://payme.hsbc.<PII_1>',
      'https://payme.hsbc_<PII_1>',
      '<PII_1>payme.hsbc/x',
    ]) {
      assert.deepEqual(hosts(redacted), [], redacted);
    }
  });
});
