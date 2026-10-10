'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { redactPii, hostFromUrl } = require('./redact');

describe('redactPii', () => {
  it('replaces HK phones with [電話]', () => {
    const a = redactPii('請打去 +852 6123 4567');
    assert.match(a.redacted, /\[電話\]/);
    assert.doesNotMatch(a.redacted, /6123/);
    assert.ok(a.mapping.some((row) => row.placeholder === '[電話]'));

    const b = redactPii('我電話係 91234567');
    assert.equal(b.redacted.includes('91234567'), false);
    assert.match(b.redacted, /\[電話\]/);

    const c = redactPii('852-5123-4567 係我號');
    assert.match(c.redacted, /\[電話\]/);
    assert.doesNotMatch(c.redacted, /5123/);

    const spaced = redactPii('我電話係 9123  4567');
    assert.match(spaced.redacted, /\[電話\]/);
    assert.doesNotMatch(spaced.redacted, /4567/);
    const intl = redactPii('打去 +852 6123  4567 呀');
    assert.match(intl.redacted, /\[電話\]/);
    assert.doesNotMatch(intl.redacted, /4567/);
  });

  it('replaces bank / FPS / PayMe ids with [戶口]', () => {
    const bank = redactPii('請轉去戶口 012-345-678-901');
    assert.match(bank.redacted, /\[戶口\]/);
    assert.doesNotMatch(bank.redacted, /012-345/);

    const fps = redactPii('轉數快ID：abc12345 快啲');
    assert.match(fps.redacted, /\[戶口\]/);
    assert.doesNotMatch(fps.redacted, /abc12345/);

    const payme = redactPii('PayMe 61239876 過數');
    assert.match(payme.redacted, /\[戶口\]/);

    const words = redactPii('fps transfer now');
    assert.equal(words.redacted, 'fps transfer now');
    const tonight = redactPii('PayMe tonight thanks');
    assert.match(tonight.redacted, /PayMe tonight/);
    const host = redactPii('https://payme.hsbc.com.hk/x');
    assert.match(host.redacted, /payme\.hsbc\.com\.hk/);
    assert.doesNotMatch(host.redacted, /\[戶口\]/);
  });

  it('replaces emails with [電郵]', () => {
    const out = redactPii('回覆到 victim.user+fps@bank.com.hk 啦');
    assert.match(out.redacted, /\[電郵\]/);
    assert.doesNotMatch(out.redacted, /victim\.user/);
  });

  it('replaces HKID-like values with [證件]', () => {
    const hkid = redactPii('身份證 A123456(7) 影張相');
    assert.match(hkid.redacted, /\[證件\]/);
    assert.doesNotMatch(hkid.redacted, /A123456/);

    const cn = redactPii('證件號 110101199001011234');
    assert.match(cn.redacted, /\[證件\]/);
    assert.doesNotMatch(cn.redacted, /110101199001011234/);
  });

  it('optionally redacts easy 我係/本人 names as [姓名]', () => {
    const named = redactPii('我係陳大文，請快啲覆我');
    assert.match(named.redacted, /我係\[姓名\]/);
    assert.doesNotMatch(named.redacted, /陳大文/);

    const short = redactPii('我係阿明，搵你');
    assert.match(short.redacted, /我係\[姓名\]/);
    assert.doesNotMatch(short.redacted, /阿明/);

    const org = redactPii('我係防騙協調中心，請提供密碼');
    assert.match(org.redacted, /我係防騙協調中心/);
    assert.doesNotMatch(org.redacted, /\[姓名\]/);

    const compound = redactPii('我係歐陽文，請快啲覆我');
    assert.equal(compound.redacted, '我係[姓名]，請快啲覆我');

    const role = redactPii('我係張經理，有嘢同你講');
    assert.match(role.redacted, /我係張經理/);
    assert.doesNotMatch(role.redacted, /\[姓名\]/);

    const miss = redactPii('我係陳小姐');
    assert.equal(miss.redacted, '我係陳小姐');
    const company = redactPii('我係陳大公司，請入數');
    assert.equal(company.redacted, '我係[姓名]公司，請入數');
    const manager = redactPii('我係歐陽文經理');
    assert.equal(manager.redacted, '我係[姓名]經理');
    const nameThenOrg = redactPii('我係陳大文公司');
    assert.equal(nameThenOrg.redacted, '我係[姓名]公司');
  });

  it('does not mask ordinary nouns after 我係/本人', () => {
    const company = redactPii('我係收數公司，你筆數要還');
    assert.doesNotMatch(company.redacted, /\[姓名\]/);
    assert.match(company.redacted, /我係收數公司/);

    const verb = redactPii('如非本人操作，請即致電 61234567');
    assert.doesNotMatch(verb.redacted, /\[姓名\]/);
    assert.match(verb.redacted, /如非本人操作/);
  });

  it('keeps only the domain for long URLs', () => {
    const long =
      '撳呢度 https://phish.example.com/login/reset?token=abc123secret&otp=999999 核實';
    const out = redactPii(long);
    assert.match(out.redacted, /https:\/\/phish\.example\.com/);
    assert.doesNotMatch(out.redacted, /abc123secret/);
    assert.doesNotMatch(out.redacted, /otp=999999/);
    assert.equal(hostFromUrl('https://a.test/x/y'), 'https://a.test');

    const www = redactPii('https://www.evil.example/secret?token=abc123');
    assert.equal(www.redacted, 'https://www.evil.example');
    const bare = redactPii('www.evil.example/secret');
    assert.equal(bare.redacted, 'https://www.evil.example');
    const glued = redactPii('請看https://evil.example/a，驗證碼123456快啲');
    assert.match(glued.redacted, /https:\/\/evil\.example/);
    assert.match(glued.redacted, /驗證碼/);
    assert.doesNotMatch(glued.redacted, /\/a/);
    const short = redactPii('bit.ly/s3cret驗證碼');
    assert.equal(short.redacted, 'bit.ly/XXX驗證碼');
    const userinfo = redactPii('https://user:s3cret@evil.example/path');
    assert.equal(userinfo.redacted, 'https://evil.example');
    assert.doesNotMatch(userinfo.redacted, /\[電郵\]/);
    assert.doesNotMatch(userinfo.redacted, /s3cret/);
  });

  it('keeps mapping local and out of the redacted string', () => {
    const out = redactPii('電郵 foo@bar.com 同 +852 9123 4567');
    assert.ok(out.mapping.length >= 2);
    for (const row of out.mapping) {
      assert.equal(out.redacted.includes(row.original.trim()), false);
    }
  });
});
