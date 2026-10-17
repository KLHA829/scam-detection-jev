'use strict';

const { domainToUnicode } = require('url');

const {
  hasOtpForwardAsk,
  hasMoneyTransferAsk,
  hasImpersonationClaim,
} = require('./scam-intent');
const { matchMaliciousHostInText } = require('./malicious-hosts');

const ALLOWED_SUFFIXES = [
  'whatsapp.com',
  'wa.me',
  'sf-express.com',
  'hsbc.com',
  'hsbc.com.hk',
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

const SCHEME_RE = /https?:\/\/[^\s<>"']+/gi;
// A hyphen belongs to the label. `not-bit.ly` is not a second host `bit.ly`.
const WWW_RE = /(?:^|[^\w./-])((?:www\.)[^\s<>"']+)/gi;

function bareHostRe() {
  return /(?:^|[^\w./-])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?)/gi;
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

function parseHttpUrl(raw) {
  const trimmed = stripTrail(raw);
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
  return new RegExp(`(?:^|[^\\w./-])((?:${alt})/[^\\s<>"']+)`, 'gi');
}

function extractUrls(text) {
  const body = String(text || '').normalize('NFKC');
  const found = [];
  const seen = new Set();
  function add(raw) {
    const url = parseHttpUrl(raw);
    if (!url) return;
    const key = url.href;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(url);
  }
  for (const match of body.match(SCHEME_RE) || []) add(match);
  for (const match of body.matchAll(WWW_RE)) add(match[1]);
  for (const match of body.matchAll(shortenerSourceRe())) add(match[1]);
  for (const match of body.matchAll(bareHostRe())) add(match[1]);
  return found;
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

function hasShortLinkSolicit(text, urls) {
  const short = urls.some((url) => isShortHost(url.hostname));
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
  const urls = extractUrls(body);
  if (!urls.length) return { hit: false, id: null, archiveReason: null };
  const { matchMaliciousHostInText } = require('./malicious-hosts');
  const malicious = matchMaliciousHostInText(body);
  if (malicious.hit) return malicious;
  if (urls.some((url) => isLookalike(url))) {
    return { hit: true, id: 'lookalike_domain', archiveReason: 'obvious_scam' };
  }
  if (hasShortLinkSolicit(body, urls)) {
    return { hit: true, id: 'short_link_solicit', archiveReason: 'obvious_scam' };
  }
  return { hit: false, id: null, archiveReason: null };
}

module.exports = {
  ALLOWED_SUFFIXES,
  PUBLIC_HOST_SUFFIXES,
  BRANDS,
  SHORTENERS,
  extractUrls,
  hostnameOf,
  isAllowlistedHost,
  isLookalike,
  heuristicEnabled,
  matchObviousScam,
  matchLinkScam,
};
