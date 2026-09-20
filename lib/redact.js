'use strict';

const EMAIL_RE =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const HKID_RE =
  /\b[A-Z]{1,2}\d{6}\s*\(?[\dA]\)?\b/gi;

const CN_ID_RE = /\b\d{17}[\dXx]\b/g;

const HK_INTL_PHONE_RE =
  /(?:\+|00)?852[\s-]*[45679]\d{3}[\s-]?\d{4}\b/g;

const HK_LOCAL_PHONE_RE =
  /(?<![0-9])[45679]\d{3}[\s-]?\d{4}(?![0-9])/g;

const BANK_LABELED_RE =
  /(?:戶口|户口|帳號|账号|帳戶|账户|卡號|卡号|a\/c(?:\s*no\.?)?|account(?:\s*(?:no\.?|number))?)\s*[:：#]?\s*[\d\s-]{6,24}/gi;

const FPS_PAYME_RE =
  /(?:\bpayme\b|轉數快|转数快|\bfps\b)(?:\s*(?:id|號碼|号码|戶口|户口|帳號|账号))?\s*[:：#]?\s*[A-Z0-9._+-]{4,32}/gi;

const CARD_RE = /(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])/g;

const URL_RE = /https?:\/\/[^\s<>"'）)】】]+/gi;

const WWW_URL_RE = /\bwww\.[^\s<>"'）)】】]+/gi;

const NAME_RE =
  /(我[係是]|本人)(?!防騙|防骗|反詐|反诈|銀行|银行|警察|公安|官方|協調|协调|客服|職員|职员|新聞|新闻|政府|入境|海關|海关|順豐|顺丰|whatsapp)([\u4e00-\u9fff]{2,4})/gi;

function pushMap(mapping, placeholder, original) {
  const value = String(original);
  if (!value) return;
  mapping.push({ placeholder, original: value });
}

function replaceAllMapped(text, regex, placeholder, mapping) {
  return String(text).replace(regex, (match) => {
    pushMap(mapping, placeholder, match);
    return placeholder;
  });
}

function hostFromUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return input;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const host = url.host || url.hostname;
    if (!host) return input;
    return url.protocol === 'http:' ? `http://${host}` : `https://${host}`;
  } catch {
    const stripped = input.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
    return stripped ? `https://${stripped}` : input;
  }
}

function redactUrls(text, mapping) {
  const replaceUrl = (match) => {
    const kept = hostFromUrl(match);
    if (kept !== match) {
      pushMap(mapping, kept, match);
    }
    return kept;
  };
  let out = String(text).replace(URL_RE, replaceUrl);
  out = out.replace(WWW_URL_RE, replaceUrl);
  return out;
}

/**
 * Rule-based PII redaction. Never uses an LLM.
 * Mapping stays in-process for local logs; callers must not send it outbound.
 */
function redactPii(text) {
  const mapping = [];
  let out = text == null ? '' : String(text);

  out = redactUrls(out, mapping);
  out = replaceAllMapped(out, EMAIL_RE, '[電郵]', mapping);
  out = replaceAllMapped(out, HKID_RE, '[證件]', mapping);
  out = replaceAllMapped(out, CN_ID_RE, '[證件]', mapping);
  out = replaceAllMapped(out, FPS_PAYME_RE, '[戶口]', mapping);
  out = replaceAllMapped(out, BANK_LABELED_RE, '[戶口]', mapping);
  out = replaceAllMapped(out, HK_INTL_PHONE_RE, '[電話]', mapping);
  out = replaceAllMapped(out, HK_LOCAL_PHONE_RE, '[電話]', mapping);
  out = replaceAllMapped(out, CARD_RE, '[戶口]', mapping);
  out = out.replace(NAME_RE, (match, prefix, name) => {
    pushMap(mapping, '[姓名]', `${prefix}${name}`);
    return `${prefix}[姓名]`;
  });

  return { redacted: out, mapping };
}

module.exports = {
  redactPii,
  hostFromUrl,
};
