'use strict';

const SELF_OTP_RE =
  /(你[的嘅]?|您的?)?(whatsapp\s*)?(驗證碼|验证码|一次性密碼|一次性密码)\s*(是|為|为|:|：)|(?:你的|你嘅|您的|whatsapp\s*)code\s*(是|為|为|:|：)|whatsapp(?:\s+official)?\s+code\s*[:：]?\s*\d|(?:do not|don't)\s+share.{0,20}code|唔好將呢個代碼|唔好將此代碼/i;

const OTP_TOKEN_RE =
  /(驗證碼|验证码|轉移代碼|转移代码|轉移碼|转移码|一次性密碼|一次性密码|verification\s*code|\botp\b|密碼|密码)/i;

const HARVEST_DIRECT_RE =
  /(發[給给]我|发给我|發給我|發送.{0,16}[給给]我|发送.{0,16}给我|轉發|转发|send.{0,24}(me|畀我|比我)|send畀|send比)/i;

const OFFER_VERB_RE = /提供|回覆|回复/g;

const OFFER_QUOTED_BEFORE = /^(?:叫你|話你|话你|叫佢|叫他|會叫|会叫)$/;

const MONEY_ACT_RE =
  /(轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|打錢|打钱|\bsend\s+(?:money|usd|usdt)\b|交保證金|交保证金|付個款|付个款|借錢|借钱|借點|借点)/i;

const MONEY_SOLICIT_RE =
  /(請|请|麻煩|麻烦|立即|立刻|即刻|即時|即时|快[點点]|幫我|帮我|盡快|尽快).{0,20}(轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|打錢|打钱|交保證金|交保证金|借錢|借钱)|轉帳到|转账到|匯到|汇到|打到.{0,8}(戶口|户口|錢包|钱包|account)|借錢給我|借钱给我/i;

/** Elderly money-warn cues (warn-only; never archive/block by keyword alone). */
const MONEY_WARN_EXTRA_RE =
  /(\bfps\b|轉數(?!快)|转数(?!快)|\bpayme\b|點數卡|点数卡|充值卡|儲值卡|储值卡|唔好打(電話|來|来)|不要打(電話|来)|勿打電話|urgent.{0,12}(money|transfer|payment))/i;

const MONEY_TOPIC_MENTION_RE =
  /(錢|money|\bfps\b|轉帳|轉賬|转账|匯款|汇款|過數|过数|打錢|打钱|借錢|借钱|payme|點數卡|点数卡|充值卡|轉數|转数)/i;

const MONEY_URGENCY_RE =
  /(急|緊急|紧急|即刻|立即|立刻|快[點点]|盡快|尽快|今日內|今日内|今晚|asap|urgent)/i;

const IMPERSONATION_RE =
  /(我[係是].{0,16}(防騙|防骗|反詐|反诈|銀行|银行|警察|公安|海關|海关|入境處|入境处|官方|協調中心|协调中心|客服|職員|职员|安全中心)|銀行職員|银行职员|whatsapp.{0,12}(官方|official|安全中心))/i;

const SECRECY_RE =
  /(不要告訴|不要告诉|唔好同任何人|別告訴|别告诉|不准[講讲說说]|保密|不要聲張|不要声张|呢件事好秘密)/;

const NEW_NUMBER_RE =
  /(換咗號碼|换了号码|新號碼|新号码|呢個新號|这个新号|新電話|新电话)/;

const NEGATED_TAIL_STOP =
  '請|请|驗證碼|验证码|發給|发给|提供|回覆|回复|轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|打錢|打钱';

const NEGATED_CLAUSE_RE = new RegExp(
  '(?:千萬不要|千万不要|請勿|请勿|切勿|不要|唔好|禁止|(?<![特識分])別|(?<![特识分])别|勿)' +
    '[^。！？!?\\n，,]{0,20}?' +
    '(?:轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|提供|轉發|转发|告訴|告诉|透露|發給|发给|打錢|打钱|交(?!易))' +
    `(?:(?!${NEGATED_TAIL_STOP})[^。！？!?\\n，,]){0,16}`,
  'g',
);

function stripNegatedAdvice(text) {
  return String(text || '').replace(NEGATED_CLAUSE_RE, ' ');
}

function hasSelfOtpLanguage(text) {
  return SELF_OTP_RE.test(String(text || ''));
}

function offerVerbNearOtp(body) {
  const verbRe = new RegExp(OFFER_VERB_RE.source, 'g');
  let match = verbRe.exec(body);
  while (match) {
    const before = body.slice(Math.max(0, match.index - 2), match.index);
    if (!OFFER_QUOTED_BEFORE.test(before)) {
      const from = Math.max(0, match.index - 24);
      const to = Math.min(body.length, match.index + match[0].length + 24);
      if (OTP_TOKEN_RE.test(body.slice(from, to))) return true;
    }
    match = verbRe.exec(body);
  }
  return false;
}

function hasOtpForwardAsk(text) {
  const body = stripNegatedAdvice(text);
  if (!OTP_TOKEN_RE.test(body)) return false;
  if (HARVEST_DIRECT_RE.test(body)) return true;
  return offerVerbNearOtp(body);
}

function hasMoneyTransferAsk(text) {
  const body = stripNegatedAdvice(text);
  return MONEY_SOLICIT_RE.test(body) ||
    (MONEY_ACT_RE.test(body) &&
      /(請|请|立即|立刻|即刻|幫我|帮我|戶口|户口|fps|轉數快|转数快|轉數|转数|payme)/i.test(body));
}

function hasMoneyWarnExtraSignal(text) {
  return MONEY_WARN_EXTRA_RE.test(stripNegatedAdvice(text));
}

/**
 * Saved-contact 熟人借錢警示: broader than short-link solicit detection.
 * Keyword hit alone does not archive or block (see money-warn.js).
 */
function hasSavedContactMoneyWarnSignal(text) {
  const body = stripNegatedAdvice(text);
  if (/借[錢钱]/.test(body)) return true;
  return hasMoneyTransferAsk(body) || hasMoneyWarnExtraSignal(body);
}

function hasMoneyTopicMention(text) {
  return MONEY_TOPIC_MENTION_RE.test(stripNegatedAdvice(text));
}

function hasUrgentMoneyAsk(text) {
  const body = stripNegatedAdvice(text);
  if (!hasMoneyTransferAsk(body) && !hasMoneyWarnExtraSignal(body)) return false;
  return (
    MONEY_URGENCY_RE.test(body) ||
    MONEY_SOLICIT_RE.test(body) ||
    /(請|请|幫我|帮我|立即|立刻|即刻)/.test(body)
  );
}

function hasImpersonationClaim(text) {
  return IMPERSONATION_RE.test(String(text || ''));
}

function hasSecrecyAsk(text) {
  return SECRECY_RE.test(String(text || ''));
}

function hasNewNumberLanguage(text) {
  return NEW_NUMBER_RE.test(String(text || ''));
}

function isShortOtpish(text, maxChars = 96) {
  const body = String(text == null ? '' : text).trim();
  if (!body || body.length > Number(maxChars) || Number(maxChars) <= 0) {
    return false;
  }
  return OTP_TOKEN_RE.test(body);
}

function analyzeScamIntent(text) {
  const selfOtpLanguage = hasSelfOtpLanguage(text);
  const otpForwardAsk = hasOtpForwardAsk(text);
  const moneyTransferAsk = hasMoneyTransferAsk(text);
  const impersonation = hasImpersonationClaim(text);
  const secrecy = hasSecrecyAsk(text);
  const newNumberLanguage = hasNewNumberLanguage(text);
  const signals = [];
  if (selfOtpLanguage) signals.push('self_otp');
  if (otpForwardAsk) signals.push('otp_forward_ask');
  if (moneyTransferAsk) signals.push('money_transfer_ask');
  if (hasMoneyWarnExtraSignal(text)) signals.push('money_warn_extra');
  if (impersonation) signals.push('impersonation');
  if (secrecy) signals.push('secrecy');
  if (newNumberLanguage) signals.push('new_number');
  return {
    selfOtpLanguage,
    otpForwardAsk,
    moneyTransferAsk,
    impersonation,
    secrecy,
    newNumberLanguage,
    signals,
  };
}

module.exports = {
  stripNegatedAdvice,
  hasSelfOtpLanguage,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasMoneyWarnExtraSignal,
  hasSavedContactMoneyWarnSignal,
  hasMoneyTopicMention,
  hasUrgentMoneyAsk,
  hasImpersonationClaim,
  hasSecrecyAsk,
  hasNewNumberLanguage,
  isShortOtpish,
  analyzeScamIntent,
};
