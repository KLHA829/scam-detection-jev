'use strict';

const { classifierThreshold } = require('./local-classifier-client');

const AXIS_NAMES = [
  'money',
  'banking',
  'otp_login',
  'impersonation',
  'urgency',
  'link_lure',
];

function axisOn(axes, name, thresh = 0.5) {
  if (!axes || typeof axes !== 'object') return false;
  const v = axes[name];
  if (typeof v === 'boolean') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n >= thresh : false;
}

function otpForwardAsk(text) {
  const t = String(text || '');
  const hasCode =
    /(驗證碼|验证码|轉移碼|转移码|短訊密碼|短信密码|\botp\b|\bcode\b)/i.test(t);
  if (!hasCode) return false;
  return /(轉發畀|转发给|轉發我|转发我|copy過嚟|copy过来|copy俾|copy给|send畀我|send俾我|send给我|發我核|发我核|發給我|发给我|將個.{0,12}轉發|把.{0,12}转发)/i.test(
    t,
  );
}

function moneyAsk(text) {
  return /(轉數快|转数快|\bfps\b|\bpayme\b|usdt|bitcoin|\bbtc\b|轉帳|转账|轉賬|匯款|汇款|保證金|保证金|禮品卡|礼品卡|轉\$|交.{0,12}(費|费|款)|幫我轉|帮我转)/i.test(
    String(text || ''),
  );
}

function impersonation(text) {
  return /(警察|警方|警區|警区|公安|海關|海关|入境處|入境处|廉署|\bicac\b|稅務局|税务局|國安|国安|whatsapp.{0,16}(官方|安全中心)|銀行職員|银行职员|我係老闆|我是老板|我是老闆)/i.test(
    String(text || ''),
  );
}

function newNumber(text) {
  return /(換咗.{0,8}號|换了.{0,8}号|舊號冇|旧号没|舊號沒|新號|新号|而家用呢個號|现在用这个号)/.test(
    String(text || ''),
  );
}

function dontCall(text) {
  return /(唔好call|唔好打|不要打电话|唔好打電話|唔好打黎|唔好打嚟|開會唔好|不方便讲电话|唔方便講電話|唔方便講电)/i.test(
    String(text || ''),
  );
}

function matchSuppress(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  if (/(新聞|新闻).{0,40}(騙|骗|假警察|騙局|骗局|詐騙|诈骗)/.test(t)) {
    return 'scam_news';
  }

  if (
    /(如果有人|有人叫你).{0,48}(騙局|骗局|唔好轉發|不要转发|千祈)/.test(t) ||
    (/(千祈唔好轉發|千万不要转发|切勿转发)/.test(t) &&
      /(otp|驗證碼|验证码|騙局|骗局)/i.test(t) &&
      !otpForwardAsk(t))
  ) {
    return 'scam_warning';
  }

  const selfOtp =
    /(我自己輸入|我自己入|自己輸入就得|喺官方App入|在官方App入|官方App.{0,16}(入|輸入)|唔使轉發|唔會send|不会发|不會send|不要转发任何人)/.test(
      t,
    );
  if (selfOtp && /(otp|驗證碼|验证码|短訊|短信)/i.test(t) && !otpForwardAsk(t)) {
    return 'self_otp';
  }

  return null;
}

function detectSignals(text, axes, axisThresh = 0.5) {
  return {
    otp_forward_ask: otpForwardAsk(text),
    money_ask: moneyAsk(text) || axisOn(axes, 'money', axisThresh),
    impersonation:
      impersonation(text) || axisOn(axes, 'impersonation', axisThresh),
    new_number: newNumber(text),
    dont_call: dontCall(text),
    banking: axisOn(axes, 'banking', axisThresh),
    otp_login: axisOn(axes, 'otp_login', axisThresh),
    urgency: axisOn(axes, 'urgency', axisThresh),
    link_lure: axisOn(axes, 'link_lure', axisThresh),
  };
}

function pickCombo(signals) {
  if (signals.otp_forward_ask) return 'otp_forward_ask';
  if (signals.impersonation && signals.money_ask) return 'impersonation_money';
  if (signals.new_number && signals.dont_call && signals.money_ask) {
    return 'new_number_money_nocall';
  }
  return null;
}

function applyClassifierPolicy(text, raw, env = process.env) {
  const base = raw && typeof raw === 'object' ? { ...raw } : {};
  base.suppressed = null;
  base.combo = null;
  base.signals = null;

  if (!base || base.skipped) {
    base.hit = false;
    base.archiveReason = null;
    return base;
  }

  const axisThreshRaw = env.SCAM_CLASSIFIER_AXIS_THRESH;
  const axisThresh =
    axisThreshRaw == null || axisThreshRaw === ''
      ? 0.5
      : Number(axisThreshRaw);
  const signals = detectSignals(
    text,
    base.axes,
    Number.isFinite(axisThresh) ? axisThresh : 0.5,
  );
  base.signals = signals;

  const suppressed = matchSuppress(text);
  if (suppressed) {
    base.hit = false;
    base.archiveReason = null;
    base.suppressed = suppressed;
    return base;
  }

  const combo = pickCombo(signals);
  if (combo) {
    base.hit = true;
    base.archiveReason = 'local_classifier_scam';
    base.combo = combo;
    return base;
  }

  const thresh =
    typeof base.threshold === 'number'
      ? base.threshold
      : classifierThreshold(env);
  const prob = typeof base.prob_scam === 'number' ? base.prob_scam : null;
  if (base.ok && prob != null && prob >= thresh) {
    base.hit = true;
    base.archiveReason = 'local_classifier_scam';
    base.combo = 'high_prob';
    return base;
  }

  base.hit = false;
  base.archiveReason = null;
  return base;
}

module.exports = {
  AXIS_NAMES,
  axisOn,
  otpForwardAsk,
  moneyAsk,
  impersonation,
  newNumber,
  dontCall,
  matchSuppress,
  detectSignals,
  pickCombo,
  applyClassifierPolicy,
};
