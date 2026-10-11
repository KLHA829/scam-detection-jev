'use strict';

const {
  stripNegatedAdvice,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
} = require('./scam-intent');
const { matchLinkScam, extractUrls, isAllowlistedHost } = require('./link-rules');

const OTP_EXPIRY_RE = /(驗證碼|verification code|\botp\b).{0,48}(過期|expired|expire)/i;
const FPS_URGENT_RE = /(轉數快|\bfps\b).{0,48}(立即|立刻).{0,24}(轉帳|轉賬|transfer)/i;
const FPS_PAYEE_RE =
  /(到此|此帳戶|此账户|呢個戶口|这个户口|我的戶口|我的户口|我個戶口|俾我|畀我|給我|给我|\bto this\b|\bmy account\b)/i;
const SF_CUSTOMS_RE = /(順豐|sf\s*express).{0,48}(清關|customs)/gi;
const SF_LINK_WINDOW = 96;

function sfCustomsHasRiskyLink(text) {
  const body = String(text || '');
  SF_CUSTOMS_RE.lastIndex = 0;
  for (const match of body.matchAll(SF_CUSTOMS_RE)) {
    const start = match.index || 0;
    const window = body.slice(start, start + match[0].length + SF_LINK_WINDOW);
    const urls = extractUrls(window);
    if (urls.some((url) => !isAllowlistedHost(url.hostname))) return true;
  }
  return false;
}

const PATTERNS = [
  {
    id: 'otp_expiry',
    match(text) {
      if (!OTP_EXPIRY_RE.test(stripNegatedAdvice(text))) return false;
      return hasOtpForwardAsk(text);
    },
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
    match(text) {
      const body = stripNegatedAdvice(text);
      return FPS_URGENT_RE.test(body) && FPS_PAYEE_RE.test(body);
    },
  },
  {
    id: 'sf_customs_link',
    match(text) {
      return sfCustomsHasRiskyLink(text);
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
    if (pattern.match(body)) {
      return { hit: true, id: pattern.id, archiveReason: 'obvious_scam' };
    }
  }
  return matchLinkScam(body);
}

module.exports = {
  PATTERNS,
  heuristicEnabled,
  matchObviousScam,
};
