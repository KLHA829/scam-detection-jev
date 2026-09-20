'use strict';

const { foldTraditionalToSimplified } = require('./cjk-fold');

const OTP_RE =
  /(驗證碼|验证码|轉移代碼|转移代码|轉移碼|转移码|verification\s*code|\botp\b)/i;
const FPS_RE = /(轉數快|转数快|\bfps\b)/i;
const URGENCY_RE =
  /(立即|立刻|即刻|即時|即时|急住|馬上|马上|盡快|尽快|就快|限時|限时)/i;
const MONEY_ACT_RE =
  /(轉帳|轉賬|转账|轉账|匯款|汇款|\bsend\b|打到|過嚟|过来|過來|轉去|转去|付給|付给|付個款|付个款|交保證金|交保证金)/i;
const WALLET_RE = /(wallet|錢包|钱包)/i;
const CRYPTO_RE = /(usdt|bitcoin|\bbtc\b)/i;
const AUTHORITY_RE =
  /(公安|警察|警方|派出所|海關|海关|入境處|入境处|廉署|\bicac\b|稅務局|税务局|國安|国安)/i;
const BANK_RE = /(銀行|银行|\bbank\b)/i;
const LINK_RE =
  /(https?:\/\/|www\.|\bbit\.ly\b|點擊.{0,12}(連結|鏈接|链接)|点击.{0,12}(連結|鏈接|链接)|點擊連結|点击链接)/i;
const CUSTOMS_RE = /(清關|清关|關稅|关税|包裹|海關|海关|順豐|顺丰|sf\s*express)/i;
const PAY_FEE_RE = /(繳|缴|罰款|罚款|清關費|清关费|關稅|关税)/i;
const SECRECY_RE =
  /(不要告訴|不要告诉|唔好同任何人|別告訴|别告诉|不准[講讲說说]|保密)/i;
const DEPOSIT_RE = /(保證金|保证金|押金)/i;
const JOB_RE = /(兼職|兼职|招聘|日結|日结|點讚|点赞)/i;
const HARVEST_ASK_RE =
  /(發[給给]我|发给我|發給我|發送.{0,16}[給给]我|发送.{0,16}给我|轉發|转发|提供|回覆|回复|send.{0,24}(me|畀我|比我)|send畀|send比)/i;
const WA_CODE_FORWARD_RE =
  /whatsapp.{0,48}(驗證碼|验证码|轉移代碼|转移代码|code).{0,40}(轉發|转发|發[給给]|发给|\bsend\b)/i;
const CRYPTO_ROMANCE_RE =
  /(交易所|套利).{0,40}(充值|充進|充进|買幣|买币|分紅|分红|返利)/i;

const PATTERNS = [
  {
    id: 'otp_expiry',
    re: /(驗證碼|验证码|verification code|\botp\b).{0,48}(過期|过期|expired|expire)/i,
  },
  {
    id: 'otp_harvest',
    match(text) {
      return OTP_RE.test(text) && HARVEST_ASK_RE.test(text);
    },
  },
  {
    id: 'wa_code_forward',
    match(text) {
      return (
        WA_CODE_FORWARD_RE.test(text) ||
        (/whatsapp/i.test(text) &&
          OTP_RE.test(text) &&
          HARVEST_ASK_RE.test(text))
      );
    },
  },
  {
    id: 'fps_urgent_transfer',
    match(text) {
      if (!FPS_RE.test(text)) return false;
      return (
        URGENCY_RE.test(text) ||
        MONEY_ACT_RE.test(text) ||
        OTP_RE.test(text) ||
        /幫我付|帮我付|付個款|付个款|借[錢钱]|要錢|要钱/.test(text)
      );
    },
  },
  {
    id: 'wa_official_ban',
    re: /whatsapp.{0,36}(官方|official|安全中心).{0,64}(封號|封号|suspend|banned|\bban\b|停用|暫停|暂停|驗證|验证)/i,
  },
  {
    id: 'wa_fake_official',
    match(text) {
      if (!/whatsapp/i.test(text)) return false;
      return (
        /(虛假註冊|虚假注册|異地登錄|异地登录|即將暫停|即将暂停|安全中心|否則停用|否则停用)/.test(
          text,
        ) &&
        (LINK_RE.test(text) ||
          OTP_RE.test(text) ||
          HARVEST_ASK_RE.test(text) ||
          URGENCY_RE.test(text) ||
          /點擊|点击|驗證|验证|停用|暫停|暂停/.test(text))
      );
    },
  },
  {
    id: 'usdt_wallet_send',
    match(text) {
      return (
        CRYPTO_RE.test(text) &&
        WALLET_RE.test(text) &&
        /(\bsend\b|轉帳|轉賬|转账|匯款|汇款|打到|轉到|转到)/i.test(text)
      );
    },
  },
  {
    id: 'sf_customs_link',
    re: /(順豐|顺丰|sf\s*express).{0,48}(清關|清关|customs).{0,96}https?:\/\//i,
  },
  {
    id: 'parcel_customs_pay',
    match(text) {
      if (!CUSTOMS_RE.test(text)) return false;
      return (
        LINK_RE.test(text) ||
        PAY_FEE_RE.test(text) ||
        CRYPTO_RE.test(text) ||
        /逮捕|遣返|扣留/.test(text)
      );
    },
  },
  {
    id: 'authority_impersonation',
    match(text) {
      if (!AUTHORITY_RE.test(text)) return false;
      return (
        OTP_RE.test(text) ||
        MONEY_ACT_RE.test(text) ||
        FPS_RE.test(text) ||
        DEPOSIT_RE.test(text) ||
        SECRECY_RE.test(text) ||
        /(凍結|冻结|洗黑錢|洗黑钱|安全帳戶|安全账户)/.test(text)
      );
    },
  },
  {
    id: 'bank_otp_link',
    match(text) {
      return BANK_RE.test(text) && OTP_RE.test(text) && LINK_RE.test(text);
    },
  },
  {
    id: 'job_deposit',
    match(text) {
      return (
        (JOB_RE.test(text) && DEPOSIT_RE.test(text)) ||
        (DEPOSIT_RE.test(text) &&
          /(指定.{0,8}(帳戶|账户|戶口|户口)|開工|开工)/.test(text))
      );
    },
  },
  {
    id: 'crypto_romance',
    match(text) {
      return CRYPTO_ROMANCE_RE.test(text);
    },
  },
  {
    id: 'secrecy_money',
    match(text) {
      return (
        SECRECY_RE.test(text) &&
        (MONEY_ACT_RE.test(text) || FPS_RE.test(text) || OTP_RE.test(text))
      );
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
  const folded = foldTraditionalToSimplified(body);
  const variants = folded === body ? [body] : [body, folded];
  for (const pattern of PATTERNS) {
    for (const sample of variants) {
      const hit =
        typeof pattern.match === 'function'
          ? pattern.match(sample)
          : pattern.re.test(sample);
      if (hit) {
        return { hit: true, id: pattern.id, archiveReason: 'obvious_scam' };
      }
    }
  }
  return { hit: false, id: null, archiveReason: null };
}

module.exports = {
  PATTERNS,
  heuristicEnabled,
  matchObviousScam,
};
