'use strict';

const {
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
  shouldSuppress,
} = require('./scam-intent');
const { extractUrls, isAllowlistedHost, matchLinkScam } = require('./link-rules');

const PATTERNS = [
  {
    id: 'otp_expiry',
    re: /(驗證碼|verification code|\botp\b).{0,48}(過期|expired|expire)/i,
  },
  {
    id: 'otp_harvest',
    match(text) {
      return hasOtpForwardAsk(text);
    },
  },
  {
    id: 'impersonation_solicitation',
    match(text) {
      return (
        hasImpersonationClaim(text) &&
        (hasOtpForwardAsk(text) || hasMoneyTransferAsk(text))
      );
    },
  },
  {
    id: 'fps_urgent_transfer',
    re: /(轉數快|\bfps\b).{0,48}(立即|立刻).{0,24}(轉帳|轉賬|transfer)/i,
  },
  {
    id: 'wa_official_ban',
    re: /whatsapp.{0,24}(官方|official).{0,48}(封號|\bsuspend\b|\bbanned\b|\bban\b)/i,
  },
  {
    id: 'usdt_wallet_send',
    match(text) {
      return (
        /(usdt|bitcoin|\bbtc\b)/i.test(text) &&
        /(wallet|錢包)/i.test(text) &&
        /(\bsend\b|轉帳|轉賬|匯款|\btransfer\b)/i.test(text)
      );
    },
  },
  {
    id: 'sf_customs_link',
    match(text) {
      if (!/(順豐|sf\s*express).{0,48}(清關|customs)/i.test(text)) return false;
      return extractUrls(text).some((url) => !isAllowlistedHost(url.hostname));
    },
  },
];

function heuristicEnabled(env = process.env) {
  const v = env.HEURISTIC_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function matchObviousScam(text, env = process.env) {
  if (!heuristicEnabled(env)) {
    return { hit: false, id: null, archiveReason: null };
  }
  const body = text == null ? '' : String(text);
  if (!body.trim()) {
    return { hit: false, id: null, archiveReason: null };
  }
  for (const pattern of PATTERNS) {
    const hit =
      typeof pattern.match === 'function'
        ? pattern.match(body)
        : pattern.re.test(body);
    if (!hit) continue;
    // A warning that only quotes a trope is not a hard hit. Link rules still run.
    if (shouldSuppress(body)) continue;
    return { hit: true, id: pattern.id, archiveReason: 'obvious_scam' };
  }
  return matchLinkScam(body);
}

module.exports = {
  PATTERNS,
  heuristicEnabled,
  matchObviousScam,
};
