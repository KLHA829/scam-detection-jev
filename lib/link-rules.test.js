'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { matchLinkScam } = require('./link-rules');
const { matchObviousScam } = require('./link-rules');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

describe('link rules', () => {
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

  it('archives an unsaved lookalike without auto-block', async () => {
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
      {
        scoreClient: createStubJevlikeClient('benign'),
        rubric,
        resolveNumber: async () => ({ digits: '85260002222', unresolvedLid: false }),
        archiveChat: async (reason) => archives.push(reason),
        blockContact: async () => {
          blocked = true;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'archive');
    assert.equal(out.decision.archiveReason, 'obvious_scam');
    assert.equal(blocked, false);
    assert.deepEqual(archives, ['obvious_scam']);
  });
});
