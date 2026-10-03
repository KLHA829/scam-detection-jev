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

// A run of 2-4 Chinese characters after 我係/本人 also swallowed ordinary nouns:
// 我係收數公司 -> 我係[姓名], and 如非本人操作 -> 如非本人[姓名], which corrupts a scam
// keyword before the LLM reads the sentence. Only mask when the run starts with a
// plausible surname, is 2-3 characters long, and is not an organisation tail.
const HK_SURNAME_CHARS =
  '陳李黃張劉周吳鄭王何梁馬羅蔡楊許謝郭洪曾邱廖賴徐朱葉沈韓馮鄧曹彭鍾蔣蕭潘譚汪陸蘇盧唐孫魏方石余姚戴宋范杜丁傅江夏高林胡袁于董程呂阮莊簡連康雷畢翁游伍古屈甄聶湯岑霍龍莫嚴龔區丘韋麥尹駱黎尤';

const ORG_TAIL = '會|公司|中心|銀行|部門|職員|客戶|集團|機構|協會|基金|學校|醫院|警署|政府';

// Two-character surnames (first char may be absent from HK_SURNAME_CHARS, e.g. 歐).
const HK_COMPOUND_SURNAMES = '歐陽|司馬|上官|諸葛|令狐|皇甫|慕容|司徒|軒轅';

// Job titles after a single-char surname: 我係張經理 is a role intro, not a personal name.
const ROLE_AFTER_SURNAME =
  '經理|主任|董事|總監|監事|專員|助理|顧問|律師|醫生|老師|警官|隊長|組長|文員|店長|小姐|先生|太太';

const NAME_TOKEN = `(?:(?:${HK_COMPOUND_SURNAMES})[\\u4e00-\\u9fff]{1,2}|[${HK_SURNAME_CHARS}](?!${ORG_TAIL})(?!${ROLE_AFTER_SURNAME})[\\u4e00-\\u9fff]{1,2}|阿[\\u4e00-\\u9fff])`;

const NAME_RE = new RegExp(
  `(我[係是]|本人)(?!防騙|防骗|反詐|反诈|銀行|银行|警察|公安|官方|協調|协调|客服|職員|职员|新聞|新闻|政府|入境|海關|海关|順豐|顺丰|whatsapp)(${NAME_TOKEN})`,
  'gi',
);

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
