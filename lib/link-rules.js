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
  'hsbc.com.hk',
  'hangseng.com',
  'payme.hsbc.com.hk',
];

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
  'youtu.be',
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
const WWW_RE = /(?:^|[^\w./])((?:www\.)[^\s<>"']+)/gi;

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

function isAllowlistedHost(hostname) {
  const host = hostnameOf(hostname);
  if (!host) return false;
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
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

function brandHit(value) {
  const folded = foldHomoglyphs(value);
  const flat = squash(value);
  if (!flat) return false;
  for (const brand of BRANDS) {
    const token = brand.replace(/-/g, '');
    if (folded.includes(brand) || flat.includes(token)) return true;
    if (Math.abs(flat.length - token.length) <= 1 && levenshtein(flat, token) === 1) {
      return true;
    }
  }
  return false;
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
  return new RegExp(`(?:^|[^\\w./])((?:${alt})/[^\\s<>"']+)`, 'gi');
}

function extractUrls(text) {
  const body = String(text || '');
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
  return found;
}

function isLookalike(url) {
  let user = '';
  if (url.username) {
    try {
      user = decodeURIComponent(url.username);
    } catch {
      user = url.username;
    }
  }
  if (user && brandHit(user)) return true;
  if (isAllowlistedHost(url.hostname)) return false;
  const labels = hostnameOf(url.hostname).split('.').filter(Boolean);
  return labels.some((label) => brandHit(label));
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

function matchLinkScam(text) {
  const body = text == null ? '' : String(text);
  if (!body.trim()) return { hit: false, id: null, archiveReason: null };
  const urls = extractUrls(body);
  if (!urls.length) return { hit: false, id: null, archiveReason: null };
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
  BRANDS,
  SHORTENERS,
  extractUrls,
  isAllowlistedHost,
  isLookalike,
  matchLinkScam,
};
