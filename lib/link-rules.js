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
  return String(raw || '').replace(/[),.;!?，。！？、]+$/g, '');
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

function extractUrlCandidates(text) {
  const body = String(text || '').normalize('NFKC')
    .replace(/(?:https?:\/\/|www\.|^|\s)[a-z0-9.。｡-]+/gi, (host) =>
      host.replace(/([a-z0-9-])[。｡](?=[a-z0-9-])/gi, '$1.'));
  const found = [];
  const seen = new Map();
  function add(candidate) {
    const { url, bare, email } = candidate;
    const key = url.href;
    if (seen.has(key)) {
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

const WARNING_HEADING_RE = /^(?:[\p{Script=Han}]{0,12}(?:防[騙骗]|反[詐诈])(?:提示|提醒|警告)|警告|(?:scam|phishing) (?:warning|alert))[ \t]*:\s*/iu;
const FAKE_SITE_RE = /^(?:(?:以下[係是]|這是|这是|呢個係)\s*)?(?:假[\p{Script=Han}]{0,12}|釣魚|钓鱼|詐騙|诈骗)(?:網站|网站|連結|链接)$|^(?:this is (?:a )?)?(?:fake|phishing|scam) (?:site|website|link)$/iu;
const LINK_ACTION = '(?:點擊|点击|撳|瀏覽|浏览|開啟|打开|登入|登錄|登录|付款|轉帳|转账|輸入資料|输入资料)';
const AVOID_LINK_RE = new RegExp(
  `^(?:千[萬万])?(?:唔好|不要|[請请]勿|切勿)\\s*${LINK_ACTION}(?:(?:或|和|、)${LINK_ACTION}){0,3}$|` +
  '^(?:do not|don\'t|never) (?:click(?: on)?|open|visit|log in|pay)$',
  'i',
);
const SHARE_WARNING_RE = /[,。.!;]\s*(?:[請请])?(?:提醒|通知)(?:屋企)?(?:[長长]者|[親亲]友|家人|大家)$/u;

function isQuotedLinkWarning(text, body, candidates) {
  // Require warning-only text around one URL; a warning headline cannot excuse an extra ask.
  if (candidates.length !== 1) return false;
  // Keep fullwidth separators out of the quoted URL's path after NFKC folds them.
  const separated = String(text).replace(/[，；](?=\S)/g, '$& ').normalize('NFKC');
  if (separated !== body) {
    const quoted = extractUrlCandidates(separated);
    if (quoted.length !== 1 || quoted[0].email || quoted[0].url.hostname !== candidates[0].url.hostname) {
      return false;
    }
    body = separated;
    candidates = quoted;
  }
  const [{ start, end }] = candidates;
  const before = body.slice(0, start).trim().replace(WARNING_HEADING_RE, '')
    .replace(/(?:[,:。.!?;、「『“"'(]\s*){1,8}$/u, '').trim();
  const after = body.slice(end).trim().replace(/^(?:[,。.!?;、」』”"')]\s*){1,8}/u, '')
    .trim().replace(/[。.!?;]{0,8}$/u, '').replace(SHARE_WARNING_RE, '').trim();
  return (FAKE_SITE_RE.test(before) && AVOID_LINK_RE.test(after)) ||
    (AVOID_LINK_RE.test(before) && FAKE_SITE_RE.test(after));
}

/**
 * Link rules: malicious-host list, then lookalike, then soliciting short links.
 * Text tropes (OTP, 轉數快, 封號, 順豐清關) do not archive or block here.
 */
function matchObviousScam(text, env = process.env, options = {}) {
  if (!heuristicEnabled(env)) {
    return { hit: false, id: null, archiveReason: null };
  }
  return matchLinkScam(text, options);
}

function isMaliciousUrlHit(heuristic) {
  return Boolean(heuristic && heuristic.hit && heuristic.id === 'malicious_host');
}

function matchLinkScam(text, { reviewForwardedWarning = false } = {}) {
  const body = text == null ? '' : String(text).normalize('NFKC');
  if (!body.trim()) return { hit: false, id: null, archiveReason: null };
  const candidates = extractUrlCandidates(body);
  if (!candidates.length) return { hit: false, id: null, archiveReason: null };
  const { matchMaliciousHostInCandidates } = require('./malicious-hosts');
  const malicious = matchMaliciousHostInCandidates(candidates);
  if (malicious.id === 'malicious_host' && reviewForwardedWarning && isQuotedLinkWarning(text, body, candidates)) {
    return { hit: false, id: null, archiveReason: null };
  }
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
  isMaliciousUrlHit,
  matchObviousScam,
  matchLinkScam,
};
