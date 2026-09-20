'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  matchSuppress,
  otpForwardAsk,
  applyClassifierPolicy,
} = require('./classifier-policy');
const { emptyClassifierResult } = require('./local-classifier-client');

const ENV = { SCAM_CLASSIFIER_ENABLED: 'true', SCAM_CLASSIFIER_THRESH: '0.85' };

function rawScore(overrides = {}) {
  return {
    ok: true,
    hit: false,
    skipped: false,
    reason: null,
    label: 'scam',
    prob_scam: 0.99,
    threshold: 0.85,
    archiveReason: null,
    error: null,
    axes: null,
    ...overrides,
  };
}

describe('classifier policy suppress', () => {
  it('suppresses news / warnings about scams', () => {
    assert.equal(
      matchSuppress('新聞話而家好多假警察騙案，叫人轉保證金，大家小心啲。'),
      'scam_news',
    );
    assert.equal(
      matchSuppress('如果有人叫你send OTP就係騙局，千祈唔好轉發驗證碼。'),
      'scam_warning',
    );
  });

  it('suppresses self-OTP / official-app instructions', () => {
    assert.equal(
      matchSuppress(
        '我自己喺銀行App申請開通，短訊OTP我自己輸入就得，唔使轉發任何人。',
      ),
      'self_otp',
    );
    assert.equal(
      matchSuppress('銀行叫我輸入驗證碼，我喺官方App入，唔會send畀第二個人。'),
      'self_otp',
    );
  });

  it('does not suppress an OTP-forward lure', () => {
    assert.equal(
      matchSuppress(
        '喂，你WhatsApp被人hack咗？我係客服，快啲將個6位數code轉發畀我，否則帳戶會鎖。',
      ),
      null,
    );
    assert.equal(
      otpForwardAsk(
        '哈哈你啱啱收到個code係我搞錯，可唔可以copy過嚟畀我呀？唔該晒。',
      ),
      true,
    );
  });
});

describe('classifier policy archive', () => {
  it('does not archive skipped / disabled results', () => {
    const out = applyClassifierPolicy(
      '細佬幫我轉數快三千',
      emptyClassifierResult({ reason: 'disabled' }),
      ENV,
    );
    assert.equal(out.hit, false);
  });

  it('archives otp_forward_ask even when prob_scam is tiny', () => {
    const out = applyClassifierPolicy(
      '哈哈你啱啱收到個code係我搞錯，可唔可以copy過嚟畀我呀？唔該晒。',
      rawScore({ prob_scam: 0.0084, label: 'not_scam' }),
      ENV,
    );
    assert.equal(out.hit, true);
    assert.equal(out.combo, 'otp_forward_ask');
    assert.equal(out.archiveReason, 'local_classifier_scam');
  });

  it('archives impersonation + money_ask', () => {
    const out = applyClassifierPolicy(
      '我哋係西九龍警區，你個名出現喺洗錢名單，即刻轉保證金去安全戶口。',
      rawScore({ prob_scam: 0.4 }),
      ENV,
    );
    assert.equal(out.hit, true);
    assert.equal(out.combo, 'impersonation_money');
  });

  it('archives new number + don’t-call + money', () => {
    const out = applyClassifierPolicy(
      '細佬，舊號冇得用喇，而家用呢個號。幫我FPS $2800先，遲啲還你，而家開會唔好call。',
      rawScore({ prob_scam: 0.2 }),
      ENV,
    );
    assert.equal(out.hit, true);
    assert.equal(out.combo, 'new_number_money_nocall');
  });

  it('archives high prob when not suppressed', () => {
    const out = applyClassifierPolicy(
      '今晚教你套利，先喺呢個盤開戶入USDT。',
      rawScore({ prob_scam: 0.9986 }),
      ENV,
    );
    assert.equal(out.hit, true);
    assert.equal(out.combo, 'high_prob');
  });

  it('does not archive high-prob news or self-OTP', () => {
    const news = applyClassifierPolicy(
      '新聞話而家好多假警察騙案，叫人轉保證金，大家小心啲。',
      rawScore({ prob_scam: 0.9934 }),
      ENV,
    );
    assert.equal(news.hit, false);
    assert.equal(news.suppressed, 'scam_news');

    const self = applyClassifierPolicy(
      '銀行叫我輸入驗證碼，我喺官方App入，唔會send畀第二個人。',
      rawScore({ prob_scam: 0.9591 }),
      ENV,
    );
    assert.equal(self.hit, false);
    assert.equal(self.suppressed, 'self_otp');
  });

  it('uses optional server axes when text cues are weak', () => {
    const out = applyClassifierPolicy('請盡快處理這件事。', rawScore({
      prob_scam: 0.2,
      axes: { money: 0.91, impersonation: 0.88, otp_login: 0.1 },
    }), ENV);
    assert.equal(out.hit, true);
    assert.equal(out.combo, 'impersonation_money');
  });

  it('does not archive ordinary chat', () => {
    const out = applyClassifierPolicy(
      '今晚尖沙咀見唔見得？我想食火鍋。',
      rawScore({ prob_scam: 0.0008, label: 'not_scam' }),
      ENV,
    );
    assert.equal(out.hit, false);
    assert.equal(out.combo, null);
  });

  it('allows text combos when HTTP scoring failed (enabled overlay)', () => {
    const out = applyClassifierPolicy(
      '快啲將個6位數code轉發畀我',
      {
        ok: false,
        hit: false,
        skipped: false,
        reason: 'timeout',
        label: null,
        prob_scam: null,
        threshold: 0.85,
        archiveReason: null,
        error: 'classifier timeout',
        axes: null,
      },
      ENV,
    );
    assert.equal(out.hit, true);
    assert.equal(out.combo, 'otp_forward_ask');
  });
});
