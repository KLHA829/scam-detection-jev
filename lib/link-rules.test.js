'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMON_TLDS,
  extractUrlCandidates,
  extractUrls,
  matchLinkScam,
  matchObviousScam,
} = require('./link-rules');
const { resetMaliciousHostsCache, reloadMaliciousHosts, loadMaliciousHosts, matchMaliciousHostInText } = require('./malicious-hosts');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

describe('link rules', () => {
  it('reviews warning-only links across sender states and LLM paths', async () => {
    const { primaryPathDeps, notScamLlmFetch } = require('./test-llm');
    const warnings = [
      ...['慎防', '提防'].map((caution) => `${caution}詐騙短訊 wsd-gov.com，切勿打開`),
      'Update: Fake SMS going around with wsd-gov.com. Do not visit.',
      'Fake site wsd-gov.com. Please verify the sender independently.',
      ...['verify', 'confirm', 'update'].map((verb) => `Fake site wsd-gov.com. Please ${verb} the sender independently.`),
      'https://www.google.com/search?q=don’t+visit+wsd-gov.com',
      'https://www.google.com/search?q=don’t+visit+wsd-gov.com&ref=hsbc-hk-secure.com',
      'Fake site wsd-gov.com. Please warn your family.',
      'Fake site wsd-gov.com — do not pay now.',
      'Fake site wsd-gov.com — never pay now.',
      ...[['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']].map(([open, close]) =>
        `小心假短訊：${open}請登入 https://wsd-gov.com/pay${close}，係假㗎`),
      'This is a scam site wsd-gov.com, do not visit.',
      ...['website', 'link', 'text', 'sms', 'message'].map((noun) => `This is a scam ${noun} wsd-gov.com, do not visit.`),
      ...['詐騙網站', '诈骗网站', '詐騙連結', '诈骗链接', '詐騙短訊', '诈骗短信'].map((noun) => `${noun} wsd-gov.com，切勿登入`),
      '【防騙提示】最近有騙徒假冒惠康網站 wellcome-hk.com 呃人買平嘢，千祈唔好撳入去！',
      '小心！有人收到假水務署短訊叫你去 wsd-gov.com 交水費，係假網站，真嘅係 wsd.gov.hk',
      '【轉發】假積金局網站 www-mpfa-org-hk.axm.info 好似真，大家唔好入個人資料！真積金局係 mpfa.org.hk',
      '【防騙】最近有假冒滙豐短訊，叫你撳 hsbc-hk-secure.com 更新資料，滙豐唔會咁做！',
      '小心假順豐短訊：「您的包裹地址不詳，請登入 sf-express-hk.top 更新」，係假㗎！',
      '防騙提醒：收到假短訊「請提供驗證碼 bit.ly/fee」唔好信',
      'HKCERT alert: Fake Wellcome site wellcome-hk.com is offering too-good-to-be-true deals. Do not enter your card details.',
      'Beware of fake SF Express texts asking you to pay a redelivery fee at sf-express-delivery.top. SF Express never asks for payment by SMS link.',
      '小心 fake website wsd-gov.com，水務署 official 係 wsd.gov.hk',
    ];
    for (const body of warnings) {
      assert.equal(matchLinkScam(body).hit, false, body);
      if (body.startsWith('https://www.google.com/')) {
        assert.deepEqual(extractUrlCandidates(body).map((candidate) => candidate.url.hostname), ['www.google.com']);
      }
      for (const close of ['”', '’', '」', '』']) {
        assert.equal(extractUrlCandidates(`https://wsd-gov.com/pay${close}`)[0].url.pathname, '/pay');
      }
      for (const savedContact of [false, true]) {
        for (const context of [false, true]) {
          const calls = [];
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
              maskClient: { maskMessages: async (messages) => {
                calls.push('mask');
                return createStubJevlikeClient().maskMessages(messages);
              } },
              fetchImpl: async (...args) => {
                calls.push('llm');
                return notScamLlmFetch()(...args);
              },
              archiveChat: async () => calls.push('archive'),
            }),
          );
          assert.equal(out.decision.action, 'ignore', body);
          assert.deepEqual(calls, ['mask', 'llm']);
        }
      }
    }
  });

  it('keeps direct and repeated-link lures on the hard-link path', () => {
    for (const body of [
      '請登入 https://wsd-gov.com 付款',
      '假網站 https://wsd-gov.com 切勿點擊。請立即付款',
      '假網站 https://wsd-gov.com 切勿點擊。請登入 https://wsd-gov.com/pay',
      '假網站 https://wsd-gov.com 切勿點擊。https://wsd-gov.com',
      '假網站 https://wsd-gov.com/pay，切勿點擊。請付款',
      '假冒網站警告，「水務署」請登入 https://wsd-gov.com',
      '小心帳戶被凍結，請立即登入 https://wsd-gov.com',
      'Scam warning: https://wsd-gov.com. Please log in now.',
      '防騙 https://wsd-gov.com 請提供驗證碼',
      '防騙 https://wsd-gov.com 請立即轉帳',
      '防騙 https://hsbc-hk-secure.com 請登入',
      '防騙 https://bit.ly/fee 請提供驗證碼',
      '防騙 https://wsd-gov.com 和 https://hsbc-hk-secure.com 都係假',
      '防騙 https://wsd-gov.com 唔好撳，請立即付款',
      '反詐騙協調中心通知：你嘅戶口涉及詐騙案，詳情見 https://wsd-gov.com',
      '【防騙提示】你嘅戶口涉及詐騙案，詳情見 https://wsd-gov.com',
      'Scam prevention centre: Your account is under investigation. Details: https://wsd-gov.com',
      '預防詐騙網站入口 https://wsd-gov.com',
      ...['反詐騙協調中心網站', '反詐騙網站', '反诈骗网站', '防詐騙網站', '防騙網站', 'anti-scam website', 'anti scam website', 'against scam website'].map((framing) =>
        `${framing} https://wsd-gov.com 幫你追回款項`),
      'Fake site wsd-gov.com — do not visit. Pay now.',
      'Fake site wsd-gov.com — do not visit, pay now.',
      ...['.', '。', '!', '！', '?', '？'].map((stop) =>
        `Never click fake links${stop} Log in at https://wsd-gov.com`),
      ...['verify', 'confirm', 'update'].flatMap((verb) => ['Please ', ''].map((prefix) =>
        `Fake SMS going around. ${prefix}${verb} your account at https://wsd-gov.com`)),
      ...['details', 'info', 'identity'].map((noun) => `Fake site wsd-gov.com. Verify your ${noun}.`),
      ...['verify', 'confirm', 'update'].flatMap((verb) =>
        ['account', 'details', 'information', 'info', 'billing', 'payment', 'card', 'identity', 'password', 'login'].map((noun) =>
          `Fake site wsd-gov.com. Please ${verb} the ${noun}.`)),
      'Fake site wsd-gov.com. Please update the billing details.',
      ...['核實', '驗證', '验证', '更新'].flatMap((verb) => ['請', '立即'].map((prefix) =>
        `小心假短訊。${prefix}${verb}你的戶口 https://wsd-gov.com`)),
      ...['click', 'open', 'visit', 'log in', 'login', 'sign in', 'pay', 'enter', 'send', 'transfer'].map((verb) =>
        `Fake site wsd-gov.com. Please ${verb} now.`),
    ]) assert.equal(matchLinkScam(body).hit, true, body);
    for (const urgent of ['立即', '馬上', '马上', '立刻', '即刻']) {
      for (const framing of ['銀行叫你', '銀行叫你，', '唔好相信銀行', '唔好相信銀行，']) {
        const body = `小心假網站，但${framing}${urgent}登入 https://wsd-gov.com`;
        assert.equal(matchLinkScam(body).hit, true, body);
      }
    }
    assert.equal(matchLinkScam(null).hit, false);
    assert.equal(matchLinkScam('防騙提醒：小心假網站').hit, false);
  });

  it('fails closed when warning review masking fails', async () => {
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

  it('flags affirmative impersonation short-link scams for AI review', () => {
    for (const body of [
      '我係銀行職員，請撳 bit.ly/xxx 核實戶口',
      '我是银行职员，请打开 tinyurl.com/xxx',
      'WhatsApp 官方：請登入 bit.ly/xxx',
      'WhatsApp 官方通知：請登入 bit.ly/xxx',
      '*WhatsApp 官方*：請登入 bit.ly/xxx',
      '⚠️ WhatsApp 官方通知：請登入 bit.ly/xxx',
      '【WhatsApp 官方】\n請登入 bit.ly/xxx',
      'WhatsApp 官方團隊：請登入 bit.ly/xxx',
      'WhatsApp 官方\n請登入 bit.ly/xxx',
      'WhatsApp 官方通知\n請登入 bit.ly/xxx',
      '提示\nWhatsApp 官方团队：请登入 bit.ly/xxx',
      '小心騙徒，我係銀行職員，請提供驗證碼 bit.ly/xxx',
    ]) assert.equal(matchLinkScam(body).id, 'short_link_solicit', body);
    assert.equal(matchLinkScam('').hit, false);
  });

  it('bounds decorated-header scanning on long multiline input', () => {
    assert.equal(matchLinkScam('*\n'.repeat(25000) + 'bit.ly/x').hit, false);
  });

  it('preserves the UTF-16 self-identification gap used on main', () => {
    const { hasImpersonationClaim } = require('./scam-intent');
    for (const [count, expected] of [[8, true], [16, false]]) {
      const body = `我係${'😀'.repeat(count)}警察 bit.ly/x`;
      assert.equal(hasImpersonationClaim(body), expected);
      assert.equal(matchLinkScam(body).hit, expected);
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

  it('flags a short link only together with OTP, impersonation, or an urgent account ask', () => {
    assert.equal(
      matchLinkScam('請提供驗證碼 https://bit.ly/fee').id,
      'short_link_solicit',
    );
    assert.equal(matchLinkScam('請提供驗證碼 bit.ly/fee').id, 'short_link_solicit');
    assert.equal(matchLinkScam('請提供驗證碼 help@bit.ly').hit, false);
    assert.equal(
      matchLinkScam('請立即轉帳到此戶口 https://tinyurl.com/pay').id,
      'short_link_solicit',
    );
    assert.equal(matchLinkScam('請轉帳 https://bit.ly/x').hit, false);
    assert.equal(matchLinkScam('請提供驗證碼 not-bit.ly/fee').hit, false);
    assert.equal(matchLinkScam('https://not-hangseng.evil.com/a').hit, false);
    assert.equal(matchLinkScam('https://my-whatsapp.example.com/a').hit, false);
    assert.equal(matchLinkScam('https://user:whatsapp@gmail.com/inbox').hit, false);
    assert.equal(
      matchLinkScam('請提供驗證碼 ｂｉｔ．ｌｙ／ｆｅｅ').id,
      'short_link_solicit',
    );
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
});
