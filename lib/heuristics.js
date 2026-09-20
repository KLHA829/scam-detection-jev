'use strict';

const PATTERNS = [
  {
    id: 'otp_expiry',
    re: /(驗證碼|verification code|\botp\b).{0,48}(過期|expired|expire)/i,
  },
  {
    id: 'fps_urgent_transfer',
    re: /(轉數快|\bfps\b).{0,48}(立即|立刻).{0,24}(轉帳|轉賬|transfer)/i,
  },
  {
    id: 'wa_official_ban',
    re: /whatsapp.{0,24}(官方|official).{0,48}(封號|suspend|banned|ban)/i,
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
    re: /(順豐|sf\s*express).{0,48}(清關|customs).{0,96}https?:\/\//i,
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
    if (hit) {
      return { hit: true, id: pattern.id, archiveReason: 'obvious_scam' };
    }
  }
  return { hit: false, id: null, archiveReason: null };
}

module.exports = {
  PATTERNS,
  heuristicEnabled,
  matchObviousScam,
};
