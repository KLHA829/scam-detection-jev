// @ts-check
'use strict';

const OTP_TOKEN_RE =
  /(驗證碼|验证码|轉移代碼|转移代码|轉移碼|转移码|一次性密碼|一次性密码|verification\s*code|\botp\b|密碼|密码)/i;

const HARVEST_DIRECT_RE =
  /(發[給给]我|发给我|發給我|發送[^。！？!?\r\n\u2028\u2029\u0085，,;；.]{0,16}[給给]我|发送[^。！？!?\r\n\u2028\u2029\u0085，,;；.]{0,16}给我|轉發|转发|send[^。！？!?\r\n\u2028\u2029\u0085，,;；.]{0,24}(me|畀我|比我)|send畀|send比)/i;

const OFFER_VERB_RE = /提供|回覆|回复/g;

const OFFER_QUOTED_BEFORE = /(?:要求你|叫你|話你|话你|叫佢|叫他|會叫|会叫)$/;

const MONEY_ACT_RE =
  /(轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|打錢|打钱|\bsend\s+(?:money|usd|usdt)\b|交保證金|交保证金|付個款|付个款)/i;

const MONEY_DESTINATION_RE = /轉帳到|转账到|匯到|汇到|打到.{0,8}(戶口|户口|錢包|钱包|account)/i;

const MONEY_SOLICIT_RE = new RegExp(
  '(請|请|麻煩|麻烦|立即|立刻|即刻|即時|即时|快[點点]|幫我|帮我|盡快|尽快).{0,20}' +
  '(轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|打錢|打钱|交保證金|交保证金)|' + MONEY_DESTINATION_RE.source,
  'i',
);

const IMPERSONATION_RE =
  /我[係是].{0,16}(防騙|防骗|反詐|反诈|銀行|银行|警察|公安|海關|海关|入境處|入境处|官方|協調中心|协调中心|客服|職員|职员|安全中心)/i;

const WHATSAPP_HEADER_RE =
  /^[^\p{L}\p{N}\r\n]{0,8}whatsapp[ \t]*(官方|official|安全中心)[ \t]*(?:通知|團隊|团队)?[^\p{L}\p{N}\r\n]{0,8}(?:[:：]|$)/imu;

const NEGATED_TAIL_STOP =
  '請|请|驗證碼|验证码|發給|发给|提供|回覆|回复|轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|打錢|打钱';

const NEGATED_CLAUSE_RE = new RegExp(
  '(?:千萬不要|千万不要|請勿|请勿|切勿|不要|唔好|唔會|不會|不会|禁止|(?<![特識分])別|(?<![特识分])别|勿)' +
    '[^。！？!?\\n，,]{0,20}?' +
    '(?:轉帳|轉賬|转账|轉账|匯款|汇款|過數|过数|提供|轉發|转发|告訴|告诉|透露|發給|发给|打錢|打钱|交(?!易))' +
    `(?:(?!${NEGATED_TAIL_STOP})[^。！？!?\\n，,]){0,16}`,
  'g',
);

const ENGLISH_NEGATED_VERB_RE =
  /\b(?:never|do[ \t]{1,8}not|don['’]t|won['’]t|will[ \t]{1,8}not|no[ \t]{1,8}one[ \t]{1,8}will)[ \t]{1,8}(?:ask[ \t]{1,8}(?:you[ \t]{1,8})?to[ \t]{1,8})?(?:send|share|forward|provide|give)\b/gi;

function stripNegatedAdvice(text) {
  return String(text || '').replace(NEGATED_CLAUSE_RE, ' ')
    .replace(ENGLISH_NEGATED_VERB_RE, '\n');
}

function offerVerbNearOtp(body) {
  return body.split(/[。！？!?；;]/).some(offerVerbNearOtpInSentence);
}

function offerVerbNearOtpInSentence(body) {
  const verbRe = new RegExp(OFFER_VERB_RE.source, 'g');
  let match = verbRe.exec(body);
  while (match) {
    const before = body.slice(Math.max(0, match.index - 3), match.index);
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
  for (const clause of body.split(/[。！？!?\r\n\u2028\u2029\u0085，,;；.]/)) {
    const verbRe = new RegExp(HARVEST_DIRECT_RE.source, 'gi');
    const tokenRe = new RegExp(OTP_TOKEN_RE.source, 'gi');
    let token = tokenRe.exec(clause);
    let match = verbRe.exec(clause);
    while (match) {
      const from = Math.max(0, match.index - 24);
      const to = match.index + match[0].length + 24;
      while (token && token.index + token[0].length <= from) token = tokenRe.exec(clause);
      if (token && token.index <= to) return true;
      match = verbRe.exec(clause);
    }
  }
  return offerVerbNearOtp(body);
}

function hasMoneyTransferAsk(text) {
  const body = stripNegatedAdvice(text);
  return MONEY_SOLICIT_RE.test(body) ||
    (MONEY_ACT_RE.test(body) &&
      /(請|请|立即|立刻|即刻|幫我|帮我|戶口|户口|fps|轉數快|转数快)/i.test(body));
}

function hasImpersonationClaim(text) {
  const body = String(text || '');
  return IMPERSONATION_RE.test(body) || WHATSAPP_HEADER_RE.test(body);
}

module.exports = {
  MONEY_ACT_RE,
  MONEY_DESTINATION_RE,
  stripNegatedAdvice,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
};
