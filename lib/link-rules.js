// @ts-check
'use strict';

const { domainToUnicode } = require('url');

const {
  MONEY_ACT_RE,
  MONEY_DESTINATION_RE,
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
  stripNegatedAdvice,
} = require('./scam-intent');

const ALLOWED_SUFFIXES = [
  'whatsapp.com',
  'wa.me',
  'sf-express.com',
  'hsbc.com',
  'hsbc.co.uk',
  'hsbc.com.au',
  'hsbc.com.cn',
  'hsbc.com.hk',
  'hsbc.com.sg',
  'hangseng.com',
  'payme.hsbc',
  'payme.hsbc.com.hk',
];

/** Brand subdomains on these hosts are other people's sites, not lookalikes. */
const PUBLIC_HOST_SUFFIXES = ['github.io', 'medium.com', 'blogspot.com'];

/** Edit distance only for names long enough that one typo is still the brand. */
const MIN_EDIT_LENGTH = 6;

const BRANDS = ['whatsapp', 'sfexpress', 'sf-express', 'hsbc', 'hangseng', 'payme'];

const SHORTENERS = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'cutt.ly',
  'rb.gy',
  'is.gd',
  't.cn',
  'dwz.cn',
  'url.cn',
];

const COMMON_TLDS = [
  'com',
  'net',
  'org',
  'info',
  'biz',
  'xyz',
  'top',
  'shop',
  'site',
  'online',
  'club',
  'vip',
  'app',
  'dev',
  'live',
  'link',
  'click',
  'icu',
  'store',
  'tech',
  'fun',
  'pro',
  'asia',
  'mobi',
  'name',
  'cloud',
  'work',
  'win',
  'bid',
  'loan',
  'today',
  'life',
  'world',
  'space',
  'website',
  'email',
  'support',
  'services',
  'help',
  'ltd',
  'group',
  'one',
  'cyou',
  'buzz',
  'rest',
  'bond',
  'sbs',
  'cfd',
  'lol',
  'monster',
  'quest',
];

const HOMOGLYPHS = {
  '\u0430': 'a',
  '\u0410': 'a',
  '\u0435': 'e',
  '\u0415': 'e',
  '\u043e': 'o',
  '\u041e': 'o',
  '\u0440': 'p',
  '\u0420': 'p',
  '\u0441': 'c',
  '\u0421': 'c',
  '\u0443': 'y',
  '\u0423': 'y',
  '\u0456': 'i',
  '\u0406': 'i',
  '\u04bb': 'h',
  '\u04ba': 'h',
};

const URL_STOP = String.raw`\s<>"'\x60{}\u3000-\u303f\uff00-\uffef`;
const MASK_TOKEN_RE = /<(?:[A-Z]+_\d+|PII)>/;
const SCHEME_RE = new RegExp(`https?://[^${URL_STOP}]+`, 'gi');
// Start after URL path/query/fragment delimiters so an enclosing URL wins.
const EMAIL_LOCAL = String.raw`\p{L}\p{M}\p{N}.!$%&'*+=^_\x60{|}~-`;
const EMAIL_LABEL = String.raw`[\p{L}\p{M}\p{N}-]+`;
const EMAIL_HOST = String.raw`(?:${EMAIL_LABEL}\.)+(?:[a-z0-9-]{2,}(?![a-z0-9-])|${EMAIL_LABEL})`;
const HOST_URL_TAIL = String.raw`(?::\d+)?(?:[/?#][^${URL_STOP}]*)?`;
const EMAIL_RE = new RegExp(
  String.raw`(?<![${EMAIL_LOCAL}])(?:"(?:[^"\\\r\n]|\\.)*"|[${EMAIL_LOCAL}]+)@(${EMAIL_HOST})(?![/\p{L}\p{N}-])`,
  'giu',
);
// A hyphen belongs to the label. `not-bit.ly` is not a second host `bit.ly`.
const WWW_RE = new RegExp(`(?:^|[^a-z0-9./-])((?:www\\.)[^${URL_STOP}]+)`, 'gi');

function bareHostRe() {
  return new RegExp(
    `(?:^|[^a-z0-9./-])((?:[a-z0-9-]+\\.)+(?:xn--[a-z0-9-]{2,}|[a-z]{2,})${HOST_URL_TAIL})`,
    'gi',
  );
}

function foldHomoglyphs(value) {
  return String(value || '')
    .replace(/[\u0430\u0410\u0435\u0415\u043e\u041e\u0440\u0420\u0441\u0421\u0443\u0423\u0456\u0406\u04bb\u04ba]/g, (ch) => HOMOGLYPHS[ch] || ch)
    .toLowerCase();
}

function squash(value) {
  return foldHomoglyphs(value).replace(/-/g, '');
}

function hostnameOf(value) {
  const unicode = domainToUnicode(String(value || ''));
  return unicode
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

function hostMatchesSuffix(hostname, suffixes) {
  const host = hostnameOf(hostname);
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isAllowlistedHost(hostname) {
  return hostMatchesSuffix(hostname, ALLOWED_SUFFIXES);
}

function isPublicHost(hostname) {
  return hostMatchesSuffix(hostname, PUBLIC_HOST_SUFFIXES);
}

function isShortHost(hostname) {
  const host = hostnameOf(hostname);
  if (!host) return false;
  return SHORTENERS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length];
}

function brandTokens() {
  return BRANDS.map((brand) => brand.replace(/-/g, ''));
}

function exactBrandLabel(label) {
  const flat = squash(label);
  return brandTokens().includes(flat);
}

/**
 * One hostname label, not a brand mentioned inside a longer word.
 * The brand has to start the label: `whatsapp-secure` matches, `not-hangseng` does not.
 * `bestwhatsapp` does not. One-character typos match only when both names are
 * at least 6 letters, so `whatspp` matches and `hsb` does not.
 */
function labelLooksLikeBrand(label) {
  const tokens = foldHomoglyphs(label)
    .split('-')
    .map((part) => part.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  if (!tokens.length) return false;
  const brands = brandTokens();
  let joined = '';
  for (let j = 0; j < tokens.length; j += 1) {
    joined += tokens[j];
    if (brands.includes(joined)) return true;
  }
  const flat = tokens.join('');
  if (flat.length < MIN_EDIT_LENGTH) return false;
  return brands.some(
    (token) =>
      token.length >= MIN_EDIT_LENGTH &&
      Math.abs(flat.length - token.length) <= 1 &&
      levenshtein(flat, token) === 1,
  );
}

const ASCII_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const IDN_LABEL_RE = /^[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?$/u;
const TRAIL_PUNCT_RE = /[),.;!?，。｡！？、”’」』*_~\x60}]+$/;

function splitTrailingPunct(raw) {
  const input = String(raw || '');
  let core = input;
  for (;;) {
    const next = core.replace(TRAIL_PUNCT_RE, '');
    if (next !== core) {
      core = next;
      continue;
    }
    if (core.endsWith(']')) {
      const opens = (core.match(/\[/g) || []).length;
      const closes = (core.match(/\]/g) || []).length;
      if (opens === 0 || closes > opens) {
        core = core.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return { core, trail: input.slice(core.length) };
}

function stripTrail(raw) {
  let out = splitTrailingPunct(raw).core;
  const cjkAfterHost = out.match(
    /^((?:https?:\/\/)?(?:[^/?#\s]+\.)+(?:xn--[a-z0-9-]+|[a-z]{2,})(?::\d+)?)[\u3400-\u9fff\uf900-\ufaff][^./?#]*$/i,
  );
  if (cjkAfterHost) {
    out = cjkAfterHost[1].replace(TRAIL_PUNCT_RE, '');
  }
  return out;
}

function parseHttpUrl(text) {
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

function shortenerSourceRe() {
  const alt = SHORTENERS.map((host) => host.replace(/\./g, '\\.')).join('|');
  return new RegExp(`(?:^|[^a-z0-9./-])((?:${alt})/[^${URL_STOP}]+)`, 'gi');
}

function isKnownTld(label) {
  const lower = String(label || '').toLowerCase();
  return /^(?:xn--[a-z0-9-]{2,}|[a-z]{2})$/.test(lower) || COMMON_TLDS.includes(lower);
}

function isSentenceCaseWord(label, left) {
  return label !== label.toLowerCase() && left === left.toLowerCase();
}

function normalizeHostSegments(hostCandidate, hasUrlTail) {
  if (!/[。｡]/.test(hostCandidate)) return hostCandidate;
  const parts = hostCandidate.split(/([。｡])/);
  const maxK = (parts.length - 1) >> 1;

  for (let k = maxK; k >= 1; k -= 1) {
    const isFull = 2 * k === parts.length - 1;
    const tailFollows = isFull && hasUrlTail;
    const lastRaw = parts[2 * k];
    if (!lastRaw) continue;

    const { core: segBase, trail: segTrail } = tailFollows
      ? { core: lastRaw, trail: '' }
      : splitTrailingPunct(lastRaw);
    if (!segBase) continue;

    let lastSeg = segBase;
    let gluedCjk = '';
    if (isFull && !hasUrlTail) {
      const cjkMatch = segBase.match(
        /^((?:(?:[a-z0-9-]+\.)*(?:xn--[a-z0-9-]+|[a-z0-9-]+))(?::\d+)?)([\u3400-\u9fff\uf900-\ufaff][^./?#]*)$/i,
      );
      if (cjkMatch) {
        lastSeg = cjkMatch[1];
        gluedCjk = cjkMatch[2];
      }
    }

    const portMatch = lastSeg.match(/^(.*):(\d+)$/);
    const lastSegHost = portMatch ? portMatch[1] : lastSeg;
    const portSuffix = portMatch ? `:${portMatch[2]}` : '';
    const hasPort = Boolean(portMatch);

    const prefixSegs = [];
    for (let j = 0; j < 2 * k; j += 2) prefixSegs.push(parts[j]);
    if (prefixSegs.some((seg) => !seg)) continue;
    if (prefixSegs.slice(1).some((seg) => !seg.split('.').every((label) => ASCII_LABEL_RE.test(label)))) {
      continue;
    }

    const host = [...prefixSegs, lastSegHost].join('.');
    const allLabels = host.split('.');
    if (allLabels.length < 2 || !allLabels.every((label) => IDN_LABEL_RE.test(label))) continue;
    if (!parseHttpUrl(`https://${host}`)) continue;

    const lastLabels = lastSegHost.split('.');
    const lastSegDotted = lastLabels.length >= 2;
    const lastSegAscii = lastLabels.every((label) => ASCII_LABEL_RE.test(label));
    const finalLabel = lastLabels[lastLabels.length - 1];
    const finalIsKnownTld = isKnownTld(finalLabel);
    const finalLooksLikeTld = /^(?:xn--[a-z0-9-]{2,}|[a-z]{2,})$/i.test(finalLabel);

    let hasEarlierCompleteHost = false;
    let runningLabels = [];
    for (const seg of prefixSegs) {
      runningLabels = runningLabels.concat(seg.split('.'));
      if (runningLabels.length >= 2 && isKnownTld(runningLabels[runningLabels.length - 1])) {
        hasEarlierCompleteHost = true;
        break;
      }
    }
    const leftHost = prefixSegs.join('.');

    let accept = false;
    if (lastSegDotted) {
      accept = tailFollows || hasPort || (finalLooksLikeTld && !isSentenceCaseWord(finalLabel, leftHost));
    } else if (lastSegAscii) {
      if (tailFollows || hasPort) {
        accept = true;
      } else if (finalIsKnownTld) {
        accept = !hasEarlierCompleteHost || !isSentenceCaseWord(finalLabel, leftHost);
      } else {
        accept = !hasEarlierCompleteHost && !isSentenceCaseWord(finalLabel, leftHost);
      }
    }

    if (accept) {
      const remainder = parts.slice(2 * k + 1).join('');
      return `${host}${portSuffix}${gluedCjk}${segTrail}${remainder}`;
    }
  }
  return hostCandidate;
}

function normalizeSchemeAuthority(full, offset, source) {
  const schemeEnd = full.indexOf('://') + 3;
  const prefix = full.slice(0, schemeEnd);
  const rest = full.slice(schemeEnd);
  if (!/[。｡]/.test(rest)) return full;
  const nextChar = source[offset + full.length] || '';
  const hasUrlTail = nextChar === '/' || nextChar === '?' || nextChar === '#';
  const { core, trail } = hasUrlTail ? { core: rest, trail: '' } : splitTrailingPunct(rest);
  if (!/[。｡]/.test(core)) return full;
  const firstStop = core.search(/[。｡]/);
  const atIdx = core.lastIndexOf('@', firstStop);
  const userinfo = atIdx >= 0 ? core.slice(0, atIdx + 1) : '';
  const hostCandidate = atIdx >= 0 ? core.slice(atIdx + 1) : core;
  const normalized = normalizeHostSegments(hostCandidate, hasUrlTail);
  return `${prefix}${userinfo}${normalized}${trail}`;
}

function normalizeIdeographicHosts(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(
      /https?:\/\/[^/\s?#<>"'\x60{}()[\],;!~*”’，！？、；：（）「」『』]+/gi,
      normalizeSchemeAuthority,
    )
    .replace(
      new RegExp(
        `https?://[^${URL_STOP}]+|((?:^|[^a-z0-9./-])((?:[a-z0-9-]+[。｡.])*[a-z0-9-]+[。｡](?:[a-z0-9-]+[。｡.])*[a-z0-9-]+)(?![a-z0-9-]*://))`,
        'gi',
      ),
      (full, hostWithLead, hostRun, offset, source) => {
        if (!hostRun) return full;
        const lead = hostWithLead.slice(0, hostWithLead.length - hostRun.length);
        const nextChar = source[offset + full.length] || '';
        const hasUrlTail = nextChar === '/' || nextChar === '?' || nextChar === '#';
        return `${lead}${normalizeHostSegments(hostRun, hasUrlTail)}`;
      },
    );
}

function extractUrlCandidates(text, deduplicate = true) {
  const body = normalizeIdeographicHosts(text);
  const found = [];
  const seen = new Map();
  function add(candidate) {
    const { url, bare, email } = candidate;
    const key = url.href;
    if (deduplicate && seen.has(key)) {
      const index = seen.get(key);
      const previous = found[index];
      if ((previous.email && !email) || (previous.email === email && previous.bare && !bare)) {
        found[index] = candidate;
      }
      return;
    }
    seen.set(key, found.length);
    found.push(candidate);
  }
  const matches = [];
  for (const { pattern, bare } of [
    { pattern: SCHEME_RE, bare: false },
    { pattern: EMAIL_RE, bare: true },
    { pattern: WWW_RE, bare: false },
    { pattern: shortenerSourceRe(), bare: false },
    { pattern: bareHostRe(), bare: true },
  ]) {
    for (const match of body.matchAll(pattern)) {
      const raw = match[1] || match[0];
      // Consume the whole email, but test its domain, not the local part.
      const emailAddress = pattern === EMAIL_RE;
      const start = emailAddress ? match.index : match.index + match[0].length - raw.length;
      const email = emailAddress || (pattern !== SCHEME_RE && body[start - 1] === '@' && !raw.includes('/'));
      matches.push({
        raw,
        start,
        end: match.index + match[0].length,
        bare: bare && !(email && /^www\./i.test(raw)),
        email,
      });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  let consumedEnd = 0;
  for (const match of matches) {
    if (match.start < consumedEnd) continue;
    const text = stripTrail(match.raw);
    const url = parseHttpUrl(text);
    if (!url) continue;
    const end = match.end - (match.raw.length - text.length);
    add({
      url, bare: match.bare, email: match.email,
      start: match.start, end,
    });
    consumedEnd = end;
  }
  return found;
}

function extractUrls(text) {
  return extractUrlCandidates(text).map(({ url }) => url);
}

function hasCommonTld(host) {
  const tld = hostnameOf(host).split('.').filter(Boolean).at(-1);
  return Boolean(tld && (/^[a-z]{2}$/.test(tld) || COMMON_TLDS.includes(tld)));
}

function decodePart(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function labelIsBrand(label) {
  return exactBrandLabel(label) || labelLooksLikeBrand(label);
}

/**
 * `whatsapp.com@evil.com` puts the brand in the username.
 * `user:pass@whatsapp.com@evil.com` puts it in the password. A bare password
 * word is not a host, so `user:whatsapp@gmail.com` stays allowed.
 */
function userinfoLooksLikeBrand(url) {
  const labels = [];
  const user = decodePart(url.username);
  if (user) labels.push(...user.split(/[.@]/));
  const pass = decodePart(url.password);
  if (pass) {
    for (const segment of pass.split('@')) {
      if (!segment.includes('.')) continue;
      labels.push(...segment.split(/[.:]/));
    }
  }
  return labels.filter(Boolean).some((label) => labelIsBrand(label));
}

function isLookalike(url) {
  if (userinfoLooksLikeBrand(url)) return true;
  if (isAllowlistedHost(url.hostname) || isPublicHost(url.hostname)) return false;
  const host = hostnameOf(url.hostname);
  const labels = host.split('.').filter(Boolean);
  return labels.some((label) => labelIsBrand(label));
}

const URGENT_ACCOUNT_LINK_RE =
  /(立即|立刻|即刻|馬上|马上|緊急|紧急|戶口|户口|帳戶|账户)/i;

const PAYMENT_ACTION = `(?:${MONEY_ACT_RE.source}|${MONEY_DESTINATION_RE.source}|付款|繳費|缴费|pay\\b|transfer\\b)`;
const PAYMENT_GAP = '[^。！？!?\\r\\n\\u2028\\u2029\\u0085，,;；]{0,20}';
const PAYMENT_LINK_RE = new RegExp(
  `(?:經|经|用|透過|通过|在|於|于|點擊|点击|撳|click\\b|use\\b)${PAYMENT_GAP}(?:連結|链接|\\blink\\b)${PAYMENT_GAP}${PAYMENT_ACTION}|` +
  `${PAYMENT_ACTION}${PAYMENT_GAP}(?:經|经|用|透過|通过|到|至|via\\b|through\\b|at\\b|using\\b)${PAYMENT_GAP}(?:連結|链接|\\blink\\b)`,
  'i',
);
const PAYMENT_ADVICE_RE = /唔好|不要|切勿|請勿|请勿|\b(?:never|don't|do not)\b/i;

function hasPaymentLinkAsk(text) {
  return stripNegatedAdvice(text).split(/[。！？!?\r\n\u2028\u2029\u0085，,;；]|\.(?=\s|$)/).some(
    (clause) => !PAYMENT_ADVICE_RE.test(clause) && PAYMENT_LINK_RE.test(clause),
  );
}

function hasShortLinkSolicit(text, candidates) {
  const short = candidates.some(({ url, email }) => !email && isShortHost(url.hostname));
  if (!short) return false;
  if (hasOtpForwardAsk(text)) return true;
  if (hasImpersonationClaim(text)) return true;
  return hasMoneyTransferAsk(text) &&
    (URGENT_ACCOUNT_LINK_RE.test(stripNegatedAdvice(text)) || hasPaymentLinkAsk(text));
}

function heuristicEnabled(env = process.env) {
  const v = env.HEURISTIC_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

const SCAM_REPORT_RE = /(?<!不是|並非|并非|唔係)(?:假冒|假[\u3400-\u9fff]{0,12}(?:網站|网站|短訊|短信|連結|链接)|[騙骗]徒|[釣钓][魚鱼]|(?:(?<![反防])|(?<=[慎提]防))[詐诈][騙骗](?:網站|网站|連結|链接|短訊|短信))|(?<!not\s+a\s+)(?<!not\s+)(?:\b(?:fake|phishing)\b|(?<!anti-)(?<!anti )(?<!against )\bscam (?:site|website|link|text|sms|message)\b)/i;
const QUOTED_REPORT_RE = /「[^「」\r\n]{0,2000}」|『[^『』\r\n]{0,2000}』|“[^“”\r\n]{0,2000}”|"[^"\r\n]{0,2000}"/g;
const REPORTED_CLAUSE_RE = /(?:叫你|要求你|聲稱|声称|asking you|tells? you|telling you)(?:(?!請|请|立即|馬上|马上|立刻|即刻|\bplease\b|\bpay now\b)[^。！？!?\r\n\u2028\u2029\u0085，,;；]){0,300}/gi;
const NEGATED_LINK_RE = /(?:唔好|不要|切勿|[請请]勿|千[萬万]|不會|不会)(?!猶豫|犹豫|錯過|错过|忘記|忘记|遲疑|迟疑)[ \t]{0,8}(?:pay now\b)?(?:(?!請|请|立即|馬上|马上|立刻|即刻|\bplease\b|\bpay now\b)[^.。！？!?\r\n\u2028\u2029\u0085，,;；]){0,300}|\b(?:never|do[ \t]+not|don't)[ \t]{1,8}(?:ask[ \t]+(?:you[ \t]+)?to[ \t]+)?(?:click|open|visit|log[ \t]+in|login|sign[ \t]+in|pay(?:\s+now)?|enter|send|share|forward|provide|give|trust|believe|use|reply)\b(?:(?!請|请|立即|馬上|马上|立刻|即刻|\bplease\b|\bpay now\b)[^.。！？!?\r\n\u2028\u2029\u0085，,;；]){0,120}/gi;
const DIRECT_LINK_ASK_RE = /(?:請|请|立即|馬上|马上|立刻|即刻|按此|點此|点击|點擊|撳)(?:[^\r\n。！？!?，,;；]){0,40}(?:登入|登錄|登录|付款|支付|點擊|点击|撳|開啟|打开|輸入|输入|轉帳|转账|匯款|汇款|核實|驗證|验证|更新)|\bplease\b[^\r\n\u2028\u2029\u0085。！？!?，,;；.]{0,40}\b(?:click|open|visit|log in|login|sign in|pay|enter|send|transfer)\b|\b(?:click|log in|login|sign in|pay now|enter your|send me|transfer)\b|\b(?:verify|confirm|update)(?:[ \t]{1,8}[a-z]{1,20}){0,3}[ \t]{1,8}(?:account|details|information|info|billing|payment|card|identity|password|login)\b/i;

function isWarningOnly(text, candidates) {
  let prose = '';
  let end = 0;
  for (const candidate of candidates) {
    prose += text.slice(end, candidate.start) + ' ';
    end = candidate.end;
  }
  prose += text.slice(end);
  if (!SCAM_REPORT_RE.test(prose)) return false;
  const { matchMaliciousHostInCandidates } = require('./malicious-hosts');
  const hardLinks = candidates.filter((candidate) =>
    matchMaliciousHostInCandidates([candidate]).hit ||
    ((!candidate.bare || hasCommonTld(candidate.url.hostname)) && isLookalike(candidate.url)) ||
    hasShortLinkSolicit(text, [candidate]));
  if (hardLinks.length !== 1) return false;
  const outside = prose.replace(QUOTED_REPORT_RE, '\n')
    .replace(REPORTED_CLAUSE_RE, '\n').replace(NEGATED_LINK_RE, '\n');
  return !DIRECT_LINK_ASK_RE.test(outside) &&
    !hasOtpForwardAsk(outside) && !hasMoneyTransferAsk(outside);
}

/**
 * Link rules: malicious-host list, then lookalike, then soliciting short links.
 * Text tropes (OTP, 轉數快, 封號, 順豐清關) do not archive or block here.
 */
function matchObviousScam(text, env = process.env) {
  if (!heuristicEnabled(env)) {
    return { hit: false, id: null, archiveReason: null };
  }
  return matchLinkScam(text);
}

function isDirectArchiveHit(heuristic) {
  return Boolean(heuristic && heuristic.hit &&
    (heuristic.id === 'malicious_host' || heuristic.id === 'malicious_email_host'));
}

function matchLinkScam(text) {
  const body = text == null ? '' : String(text).normalize('NFKC');
  if (!body.trim()) return { hit: false, id: null, archiveReason: null };
  const candidates = extractUrlCandidates(body);
  if (!candidates.length) return { hit: false, id: null, archiveReason: null };
  const warningText = String(text).replace(/[，；](?=\S)/g, '$& ').normalize('NFKC');
  if (isWarningOnly(warningText, extractUrlCandidates(warningText, false))) {
    return { hit: false, id: null, archiveReason: null };
  }
  const { matchMaliciousHostInCandidates } = require('./malicious-hosts');
  const malicious = matchMaliciousHostInCandidates(candidates);
  if (malicious.hit) return malicious;
  if (
    candidates.some(
      (candidate) =>
        (!candidate.bare || hasCommonTld(candidate.url.hostname)) &&
        isLookalike(candidate.url),
    )
  ) {
    return { hit: true, id: 'lookalike_domain', archiveReason: null };
  }
  if (hasShortLinkSolicit(body, candidates)) {
    return { hit: true, id: 'short_link_solicit', archiveReason: null };
  }
  return { hit: false, id: null, archiveReason: null };
}

/**
 * A mask token inside the same URL authority means masking may have destroyed the
 * original host boundary. Tokens before an `@` are userinfo/email localpart and do
 * not affect that boundary; tokens after a `/`, `?` or `#` are path/query content.
 */
function authorityHasMaskToken(raw, wordStart, wordEnd, hostStart, hostEnd) {
  const beforeHost = raw.slice(wordStart, hostStart);
  const schemeAt = beforeHost.lastIndexOf('://');
  const authorityStart = schemeAt >= 0 ? wordStart + schemeAt + 3 : wordStart;
  let authorityEnd = wordEnd;
  for (const mark of ['/', '?', '#']) {
    const at = raw.indexOf(mark, authorityStart);
    if (at >= 0 && at < authorityEnd) authorityEnd = at;
  }
  const authorityBeforeHost = raw.slice(authorityStart, hostStart);
  const afterLastAt = authorityBeforeHost.slice(authorityBeforeHost.lastIndexOf('@') + 1);
  return MASK_TOKEN_RE.test(afterLastAt) || MASK_TOKEN_RE.test(raw.slice(hostEnd, authorityEnd));
}

/**
 * Where each link to a brand's own domain (the allowlist) names that domain, as offsets into
 * `text`. A link is left out unless `text` has the domain at exactly that place, so the offsets
 * never cover anything but the domain.
 */
function officialHosts(text) {
  const raw = String(text || '');
  const found = [];
  // Each word is normalised on its own, so a `…` elsewhere in the message cannot move a domain.
  for (const word of raw.matchAll(/\S+/g)) {
    const body = normalizeIdeographicHosts(word[0]);
    for (const { url, start, end } of extractUrlCandidates(body, false)) {
      const host = url.hostname.replace(/\.$/, '');
      if (!isAllowlistedHost(host)) continue;
      const [lead, scheme] = /^([a-z][a-z0-9+.-]*:\/\/)?(?:[^/?#@\s]*@)?/i.exec(body.slice(start, end));
      const at = word.index + start + lead.length;
      const until = at + host.length;
      // In `https://whatsapp.com。x@evil.com` or `"chan payme.hsbc"@gmail.com` the brand is only part of a login or email.
      const login = (scheme ? /^[^\s/?#]*@/ : /^["\w.+。｡．-]*@/).test(raw.slice(until));
      const exact = raw.slice(at, until).toLowerCase() === host;
      // A host glued to a mask token (`<PII_1>`), or separated from one only by
      // authority remnants such as `.` or `_`, is not vouched: masking ate the
      // original boundary, so the masked text cannot prove the host was official.
      const maskedAuthority = authorityHasMaskToken(raw, word.index, word.index + word[0].length, at, until);
      if (exact && !login && !maskedAuthority && raw[at - 1] !== '>' && raw[until] !== '<' && !/[a-z0-9.-]/i.test(raw[at - 1] || '') && !/[a-z0-9-]/i.test(raw[until] || '')) {
        found.push({ host, start: at, end: until });
      }
    }
  }
  return found;
}

module.exports = {
  ALLOWED_SUFFIXES,
  PUBLIC_HOST_SUFFIXES,
  BRANDS,
  SHORTENERS,
  COMMON_TLDS,
  extractUrlCandidates,
  extractUrls,
  hostnameOf,
  isAllowlistedHost,
  isLookalike,
  officialHosts,
  heuristicEnabled,
  isDirectArchiveHit,
  matchObviousScam,
  matchLinkScam,
};
