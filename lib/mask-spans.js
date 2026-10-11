'use strict';

const { domainToUnicode } = require('url');

/**
 * Offline stand-in for the jevlike PII head.
 * The stub uses this so npm test does not load the encoder.
 * jevlike_serve.find_mask_spans is the training-label copy; keep the two in step.
 * Live POST /v1/mask does not apply these rules. It returns the head's spans,
 * or 503 when the head is not loaded.
 */

const HK_SURNAME_CHARS =
  '陳李黃張劉周吳鄭王何梁馬羅蔡楊許謝郭洪曾邱廖賴徐朱葉沈韓馮鄧曹彭鍾蔣蕭潘譚汪陸蘇盧唐孫魏方石余姚戴宋范杜丁傅江夏高林胡袁于董程呂阮莊簡連康雷畢翁游伍古屈甄聶湯岑霍龍莫嚴龔區丘韋麥尹駱黎尤';

const ORG_TAIL = '會|公司|中心|銀行|部門|職員|客戶|集團|機構|協會|基金|學校|醫院|警署|政府';
const HK_COMPOUND_SURNAMES = '歐陽|司馬|上官|諸葛|令狐|皇甫|慕容|司徒|軒轅';
const ROLE_AFTER_SURNAME =
  '經理|主任|董事|總監|監事|專員|助理|顧問|律師|醫生|老師|警官|隊長|組長|文員|店長|小姐|先生|太太';
const NAME_TOKEN = `(?:(?:${HK_COMPOUND_SURNAMES})[\\u4e00-\\u9fff]{1,2}|[${HK_SURNAME_CHARS}](?!${ORG_TAIL})(?!${ROLE_AFTER_SURNAME})[\\u4e00-\\u9fff]{1,2}|阿[\\u4e00-\\u9fff])`;

const RULES = [
  {
    label: 'email',
    re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    label: 'id',
    re: /\b[A-Z]{1,2}\d{6}\s*\(?[\dA]\)?\b/gi,
  },
  {
    label: 'id',
    re: /\b\d{17}[\dXx]\b/g,
  },
  {
    label: 'phone',
    re: /(?:\+|00)?852[\s-]*[45679]\d{3}[\s-]?\d{4}\b/g,
  },
  {
    label: 'phone',
    re: /(?<![0-9])[45679]\d{3}[\s-]?\d{4}(?![0-9])/g,
  },
  {
    label: 'phone',
    re: /(?<![0-9])(?:\+?\d[\d\s-]{7,20}\d)(?![0-9])/g,
  },
  {
    label: 'account',
    re: /(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])/g,
  },
  {
    label: 'account',
    re: /(?:戶口|户口|帳號|账号|帳戶|账户|卡號|卡号|a\/c(?:\s*no\.?)?|account(?:\s*(?:no\.?|number))?)\s*[:：#]?\s*([\d\s-]{6,24})/gi,
    group: 1,
  },
  {
    label: 'account',
    re: /(?:\bpayme\b|轉數快|转数快|\bfps\b)(?:\s*(?:id|號碼|号码|戶口|户口|帳號|账号))?\s*[:：#]?\s*([A-Z0-9._+-]{4,32})/gi,
    group: 1,
  },
];

const NAME_RE = new RegExp(
  `(我[係是]|本人)(?!防騙|防骗|反詐|反诈|銀行|银行|警察|公安|官方|協調|协调|客服|職員|职员|新聞|新闻|政府|入境|海關|海关|順豐|顺丰|whatsapp)(${NAME_TOKEN})`,
  'gi',
);

const URL_RE = /https?:\/\/[^\s<>"'）)】]+/gi;
const WWW_RE = /\bwww\.[^\s<>"'）)】]+/gi;
const SHORT_RE = /\b((?:wa\.me|t\.me|bit\.ly|tinyurl\.com)\/)(\S+)/gi;

function spansFromRegex(text, re, label, groupIndex) {
  const spans = [];
  let flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  if (!flags.includes('d')) flags += 'd';
  const copy = new RegExp(re.source, flags);
  let match = copy.exec(text);
  while (match) {
    let start = match.index;
    let end = match.index + match[0].length;
    if (groupIndex && match.indices && match.indices[groupIndex]) {
      start = match.indices[groupIndex][0];
      end = match.indices[groupIndex][1];
    }
    if (end > start) spans.push({ start, end, label });
    if (match[0].length === 0) copy.lastIndex += 1;
    match = copy.exec(text);
  }
  return spans;
}

function otpSpans(text) {
  const spans = [];
  const near =
    /(?:驗證碼|验证码|一次性密碼|一次性密码|密碼|密码|\bcode\b|\botp\b)[^\d]{0,16}(\d{4,8})(?![0-9])/gi;
  spans.push(...spansFromRegex(text, near, 'otp', 1));
  spans.push(
    ...spansFromRegex(text, /(?<![0-9])\d{6,8}(?![0-9])/g, 'otp', 0),
  );
  return spans;
}

function urlHostNeedle(url) {
  const host = domainToUnicode(String(url.hostname || '')).toLowerCase();
  if (!host) return '';
  return url.port ? `${host}:${url.port}` : host;
}

function urlSpans(text) {
  const spans = [];
  for (const re of [URL_RE, WWW_RE]) {
    const copy = new RegExp(re.source, re.flags);
    let match = copy.exec(text);
    while (match) {
      const raw = match[0];
      const abs = match.index;
      try {
        const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
        const needle = urlHostNeedle(url);
        const hostAt = needle ? raw.toLowerCase().indexOf(needle) : -1;
        if (hostAt < 0) {
          spans.push({ start: abs, end: abs + raw.length, label: 'url' });
        } else {
          const schemeAt = raw.indexOf('://');
          const userAt = schemeAt >= 0 ? schemeAt + 3 : 0;
          const at = raw.lastIndexOf('@', hostAt);
          if (at > userAt && at < hostAt) {
            spans.push({ start: abs + userAt, end: abs + at, label: 'url' });
          }
          const secretAt = hostAt + needle.length;
          if (secretAt < raw.length) {
            spans.push({
              start: abs + secretAt,
              end: abs + raw.length,
              label: 'url',
              replacement: ' XXX',
            });
          }
        }
      } catch {
        spans.push({ start: abs, end: abs + raw.length, label: 'url' });
      }
      if (raw.length === 0) copy.lastIndex += 1;
      match = copy.exec(text);
    }
  }
  const short = new RegExp(SHORT_RE.source, SHORT_RE.flags);
  let match = short.exec(text);
  while (match) {
    const prefix = match[1] || '';
    const secret = match[2] || '';
    if (secret) {
      const start = match.index + prefix.length;
      spans.push({ start, end: start + secret.length, label: 'url' });
    }
    match = short.exec(text);
  }
  return spans;
}

function nameSpans(text) {
  const spans = [];
  const copy = new RegExp(NAME_RE.source, NAME_RE.flags);
  let match = copy.exec(text);
  while (match) {
    const name = match[2] || '';
    const prefix = match[1] || '';
    if (name) {
      const start = match.index + prefix.length;
      spans.push({ start, end: start + name.length, label: 'name' });
    }
    if (match[0].length === 0) copy.lastIndex += 1;
    match = copy.exec(text);
  }
  return spans;
}

function mergeSpans(spans) {
  const ordered = spans
    .filter((span) => span && Number.isInteger(span.start) && Number.isInteger(span.end))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of ordered) {
    const prev = merged[merged.length - 1];
    if (prev && span.start < prev.end) {
      if (span.end > prev.end) prev.end = span.end;
      continue;
    }
    merged.push({
      start: span.start,
      end: span.end,
      label: span.label || 'pii',
      ...(span.replacement ? { replacement: span.replacement } : {}),
    });
  }
  return merged;
}

function findMaskSpans(text) {
  const body = text == null ? '' : String(text);
  if (!body) return [];
  const spans = [];
  for (const rule of RULES) {
    spans.push(...spansFromRegex(body, rule.re, rule.label, rule.group || 0));
  }
  spans.push(...otpSpans(body));
  spans.push(...urlSpans(body));
  spans.push(...nameSpans(body));
  return mergeSpans(spans);
}

function applyXxx(text, spans) {
  const src = text == null ? '' : String(text);
  const ranges = mergeSpans(Array.isArray(spans) ? spans : []).filter(
    (span) => span.start >= 0 && span.end <= src.length,
  );
  let out = src;
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const span = ranges[i];
    const token = span.replacement || 'XXX';
    out = `${out.slice(0, span.start)}${token}${out.slice(span.end)}`;
  }
  return out;
}

module.exports = {
  findMaskSpans,
  applyXxx,
  mergeSpans,
};
