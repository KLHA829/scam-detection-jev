// @ts-check
'use strict';

const { domainToUnicode } = require('url');

const {
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
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

const URL_STOP = String.raw`\s<>"'\u3000-\u303f\uff00-\uffef`;
const SCHEME_RE = new RegExp(`https?://[^${URL_STOP}]+`, 'gi');
// Start after URL path/query/fragment delimiters so an enclosing URL wins.
const EMAIL_LOCAL = String.raw`\p{L}\p{M}\p{N}.!$%&'*+=^_\x60{|}~-`;
const EMAIL_LABEL = String.raw`[\p{L}\p{M}\p{N}-]+`;
const EMAIL_HOST = String.raw`(?:${EMAIL_LABEL}\.)+(?:[a-z0-9-]{2,}(?![a-z0-9-])|${EMAIL_LABEL})`;
const HOST_URL_TAIL = String.raw`(?::\d+)?(?:[/?#][^${URL_STOP}]*)?`;
const EMAIL_RE = new RegExp(
  String.raw`(?<![${EMAIL_LOCAL}])(?:"(?:[^"\\\r\n]|\\.)*"|[${EMAIL_LOCAL}]+)@(${EMAIL_HOST}${HOST_URL_TAIL})`,
  'giu',
);
// A hyphen belongs to the label. `not-bit.ly` is not a second host `bit.ly`.
const WWW_RE = new RegExp(`(?:^|[^\\w./-])((?:www\\.)[^${URL_STOP}]+)`, 'gi');

function bareHostRe() {
  return new RegExp(`(?:^|[^\\w./-])((?:[a-z0-9-]+\\.)+[a-z]{2,}${HOST_URL_TAIL})`, 'gi');
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

function stripTrail(raw) {
  return String(raw || '').replace(/[),.;!?，。！？、”’」』]+$/g, '');
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
  return new RegExp(`(?:^|[^\\w./-])((?:${alt})/[^${URL_STOP}]+)`, 'gi');
}

function extractUrlCandidates(text, deduplicate = true) {
  const body = String(text || '').normalize('NFKC')
    .replace(/(?:https?:\/\/|www\.|^|\s)[a-z0-9.。｡-]+/gi, (host) =>
      host.replace(/([a-z0-9-])[。｡](?=[a-z0-9-])/gi, '$1.'));
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
      const email = emailAddress || (pattern !== SCHEME_RE && body[start - 1] === '@');
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
    add({
      url, bare: match.bare, email: match.email,
      start: match.start, end: match.start + text.length,
    });
    consumedEnd = match.end;
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
  /(立即|立刻|即刻|馬上|马上|緊急|紧急|戶口|户口|帳戶|账户|連結|链接|\blink\b)/i;

function hasShortLinkSolicit(text, candidates) {
  const short = candidates.some(({ url, email }) => !email && isShortHost(url.hostname));
  if (!short) return false;
  if (hasOtpForwardAsk(text)) return true;
  if (hasImpersonationClaim(text)) return true;
  return hasMoneyTransferAsk(text) && URGENT_ACCOUNT_LINK_RE.test(String(text || ''));
}

function heuristicEnabled(env = process.env) {
  const v = env.HEURISTIC_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

const SCAM_REPORT_RE = /假冒|假[\u3400-\u9fff]{0,12}(?:網站|网站|短訊|短信|連結|链接)|[騙骗]徒|[釣钓][魚鱼]|(?<![反防])[詐诈][騙骗](?:網站|网站|連結|链接|短訊|短信)|\b(?:fake|phishing)\b|(?<!anti-)(?<!anti )(?<!against )\bscam (?:site|website|link|text|sms|message)\b/i;
const QUOTED_REPORT_RE = /「[^「」\r\n]{0,2000}」|『[^『』\r\n]{0,2000}』|“[^“”\r\n]{0,2000}”|"[^"\r\n]{0,2000}"/g;
const REPORTED_CLAUSE_RE = /(?:叫你|要求你|聲稱|声称|asking you|tells? you|telling you)(?:(?!請|请|立即|馬上|马上|立刻|即刻|\bplease\b|\bpay now\b)[^。！？!?\r\n\u2028\u2029\u0085，,;；]){0,300}/gi;
const NEGATED_LINK_RE = /(?:唔好|不要|切勿|[請请]勿|千[萬万]|不會|不会|\bnever\b|\bdo not\b|\bdon't\b)[ \t]{0,8}(?:pay now\b)?(?:(?!請|请|立即|馬上|马上|立刻|即刻|\bplease\b|\bpay now\b)[^。！？!?\r\n\u2028\u2029\u0085，,;；]){0,300}/gi;
const DIRECT_LINK_ASK_RE = /(?:請|请|立即|馬上|马上|立刻|即刻|按此|點此|点击|點擊|撳)(?:[^\r\n。！？!?，,;；]){0,40}(?:登入|登錄|登录|付款|支付|點擊|点击|撳|開啟|打开|輸入|输入|轉帳|转账|匯款|汇款)|\bplease\b[^\r\n\u2028\u2029\u0085。！？!?，,;；.]{0,40}\b(?:click|open|visit|log in|login|sign in|pay|enter|send|transfer)\b|\b(?:click|log in|login|sign in|pay now|enter your|send me|transfer)\b/i;

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
 * Hard hits are link rules: malicious-host list, then lookalike, then soliciting short links.
 * Text tropes (OTP, 轉數快, 封號, 順豐清關) do not archive or block here.
 */
function matchObviousScam(text, env = process.env) {
  if (!heuristicEnabled(env)) {
    return { hit: false, id: null, archiveReason: null };
  }
  return matchLinkScam(text);
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
    return { hit: true, id: 'lookalike_domain', archiveReason: 'obvious_scam' };
  }
  if (hasShortLinkSolicit(body, candidates)) {
    return { hit: true, id: 'short_link_solicit', archiveReason: 'obvious_scam' };
  }
  return { hit: false, id: null, archiveReason: null };
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
  heuristicEnabled,
  matchObviousScam,
  matchLinkScam,
};
