// @ts-check
'use strict';

const { domainToUnicode } = require('url');
const psl = require('psl');

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
const HOST_ONLY_PREFIX_SRC = String.raw`(?:[^/?#@\s,;!():[\]|^\\”’“‘—–·~&]+\.)+(?:xn--[a-z0-9-]+|[a-z]{2,})`;
const HOST_PREFIX_SRC = String.raw`${HOST_ONLY_PREFIX_SRC}(?::\d+)?`;
const INVALID_PORT_HOST_RE = new RegExp(String.raw`^(${HOST_ONLY_PREFIX_SRC}):(\d+)(.*)$`, 'i');
const IPV6_PORT_RE = /^(\[[^\]]+]):(\d+)(.*)$/;

function isValidPort(digits) {
  if (!digits || !/^\d+$/.test(digits)) return false;
  const trimmed = digits.replace(/^0+/, '') || '0';
  return trimmed.length <= 5 && Number(trimmed) <= 65535;
}
const CJK_CHAR_SRC = String.raw`\u3400-\u9fff\uf900-\ufaff`;
const GLUED_PUNCT_SRC = String.raw`(?:[,;!()”’“‘—–·~&]|\.{2,})`;
const GLUED_UNDOTTED_CAPTION_SRC = String.raw`(?:[,;!()”’“‘—–·]|\.{2,})[^./?#\\@]*`;
const FORBIDDEN_HOST_BREAK_RE = new RegExp(
  String.raw`^(${HOST_PREFIX_SRC})(?:[|^[\]]|:(?!\d+(?:$|[/?#\\]|${GLUED_PUNCT_SRC}[${CJK_CHAR_SRC}]|${GLUED_UNDOTTED_CAPTION_SRC}$))).*$`,
  'i',
);
const GLUED_PUNCT_CJK_RE = new RegExp(
  String.raw`^(${HOST_PREFIX_SRC})(${GLUED_PUNCT_SRC}(?:[,;!()”’“‘—–·~&.\s]*[${CJK_CHAR_SRC}]).*)$`,
  'i',
);
const GLUED_UNDOTTED_CAPTION_RE = new RegExp(
  String.raw`^(${HOST_PREFIX_SRC})(${GLUED_UNDOTTED_CAPTION_SRC})$`,
  'i',
);
const GLUED_DIRECT_CJK_RE = new RegExp(
  String.raw`^(${HOST_PREFIX_SRC})([${CJK_CHAR_SRC}][^./?#\\]*)$`,
  'i',
);

function continuesDomainAfterGlue(authSegment, tail) {
  if (!tail || tail.startsWith('..') || tail.includes('@')) return false;
  if (!parseHttpUrl(`https://${authSegment}`)) return false;
  return /^[,;!()”’“‘—–·~&][^\s/?#@,;!—–”’“‘.]*\.(?:[\p{L}\p{N}\p{M}-]+\.)*(?:xn--[a-z0-9-]+|[a-z]{2,}|[\p{L}\p{M}]{2,})(?::\d+)?$/iu.test(
    tail,
  );
}

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

function hasOuterUrlTail(authEnd, authSegment) {
  return (
    authEnd !== -1 &&
    !/[\u3400-\u9fff\uf900-\ufaff]/.test(authSegment) &&
    !/https?:$/i.test(authSegment)
  );
}

function unparsedSchemeTailOffset(raw) {
  const schemeMatch = raw.match(/^https?:\/\//i);
  if (!schemeMatch) return -1;
  const afterScheme = raw.slice(schemeMatch[0].length);
  const authEnd = afterScheme.search(/[/?#\\]/);
  if (authEnd <= 0) return -1;
  const authSegment = afterScheme.slice(0, authEnd);
  if (!hasOuterUrlTail(authEnd, authSegment)) return -1;
  return schemeMatch[0].length + authEnd;
}

function stripTrailInfo(raw) {
  const out = splitTrailingPunct(raw).core;
  const schemeMatch = out.match(/^https?:\/\//i);
  const schemeLen = schemeMatch ? schemeMatch[0].length : 0;
  const afterScheme = out.slice(schemeLen);
  const authEnd = afterScheme.search(/[/?#\\]/);
  const authority = authEnd === -1 ? afterScheme : afterScheme.slice(0, authEnd);
  const atIdx = authority.lastIndexOf('@');
  const validUserinfo =
    schemeLen > 0 &&
    atIdx >= 0 &&
    !/[\u3400-\u9fff\uf900-\ufaff]/.test(authority.slice(0, atIdx));
  const userinfoPrefix = validUserinfo
    ? out.slice(0, schemeLen + atIdx + 1)
    : out.slice(0, schemeLen);
  const hostAndRest = out.slice(userinfoPrefix.length);

  const authSegment =
    authEnd === -1
      ? hostAndRest
      : hostAndRest.slice(0, Math.max(0, authEnd - (userinfoPrefix.length - schemeLen)));
  const enclosingTail = hasOuterUrlTail(authEnd, authSegment);

  if (hostAndRest.startsWith('[')) {
    const ipv6Port = authSegment.match(IPV6_PORT_RE);
    if (ipv6Port && (!isValidPort(ipv6Port[2]) || (enclosingTail && Boolean(ipv6Port[3])))) {
      return { text: `${userinfoPrefix}${ipv6Port[1]}`, hasMalformedTail: enclosingTail };
    }
  } else {
    const invalidPort = authSegment.match(INVALID_PORT_HOST_RE);
    if (invalidPort && (!isValidPort(invalidPort[2]) || (enclosingTail && Boolean(invalidPort[3])))) {
      return {
        text: `${userinfoPrefix}${invalidPort[1]}`.replace(TRAIL_PUNCT_RE, ''),
        hasMalformedTail: enclosingTail,
      };
    }
    const forbidden = authSegment.match(FORBIDDEN_HOST_BREAK_RE);
    if (forbidden) {
      return {
        text: `${userinfoPrefix}${forbidden[1]}`.replace(TRAIL_PUNCT_RE, ''),
        hasMalformedTail: enclosingTail,
      };
    }
  }

  const gluedCjk = authSegment.match(GLUED_PUNCT_CJK_RE);
  if (gluedCjk && !continuesDomainAfterGlue(authSegment, gluedCjk[2])) {
    return { text: `${userinfoPrefix}${gluedCjk[1]}`.replace(TRAIL_PUNCT_RE, ''), hasMalformedTail: false };
  }

  if (authEnd === -1) {
    const caption = hostAndRest.match(GLUED_UNDOTTED_CAPTION_RE);
    if (caption) {
      return { text: `${userinfoPrefix}${caption[1]}`.replace(TRAIL_PUNCT_RE, ''), hasMalformedTail: false };
    }
    const directCjk = hostAndRest.match(GLUED_DIRECT_CJK_RE);
    if (directCjk) {
      return { text: `${userinfoPrefix}${directCjk[1]}`.replace(TRAIL_PUNCT_RE, ''), hasMalformedTail: false };
    }
  }
  return { text: out, hasMalformedTail: false };
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

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

function nfkcWithOffsetMap(raw) {
  const chunks = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(raw)) {
    const segEnd = index + segment.length;
    const segNfkc = segment.normalize('NFKC');
    const prev = chunks[chunks.length - 1];
    if (prev) {
      const combined = (prev.raw + segment).normalize('NFKC');
      if (combined !== prev.nfkc + segNfkc) {
        prev.raw += segment;
        prev.end = segEnd;
        prev.nfkc = combined;
        continue;
      }
    }
    chunks.push({ start: index, end: segEnd, raw: segment, nfkc: segNfkc });
  }
  let nfkc = '';
  const mapStart = [];
  const mapEnd = [];
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.nfkc.length; i += 1) {
      mapStart.push(chunk.start);
      mapEnd.push(chunk.end);
    }
    nfkc += chunk.nfkc;
  }
  return { nfkc, mapStart, mapEnd };
}

function replaceIdeographicDotsOnce(nfkc) {
  return nfkc
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

function replaceIdeographicDots(nfkc) {
  let cur = nfkc;
  for (let i = 0; i < 8; i += 1) {
    const next = replaceIdeographicDotsOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function normalizeIdeographicHosts(text) {
  return replaceIdeographicDots(String(text || '').normalize('NFKC'));
}

/**
 * @param {string} body
 * @param {boolean} [deduplicate]
 * @param {Array<{ start: number, end: number }>} [unparsedTails]
 */
function extractUrlCandidatesFromNormalized(body, deduplicate = true, unparsedTails) {
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
  const patternSpecs = [
    { pattern: SCHEME_RE, bare: false, isScheme: true, isEmail: false },
    { pattern: EMAIL_RE, bare: true, isScheme: false, isEmail: true },
    { pattern: WWW_RE, bare: false, isScheme: false, isEmail: false },
    { pattern: bareHostRe(), bare: true, isScheme: false, isEmail: false },
  ];
  function collectMatches(source, fromIndex = 0) {
    const out = [];
    const scanStart = Math.max(0, fromIndex - 1);
    for (let priority = 0; priority < patternSpecs.length; priority += 1) {
      const { pattern, bare, isScheme, isEmail } = patternSpecs[priority];
      const re = new RegExp(pattern.source, pattern.flags);
      re.lastIndex = scanStart;
      let match;
      while ((match = re.exec(source)) !== null) {
        const raw = match[1] || match[0];
        // Consume the whole email, but test its domain, not the local part.
        const start = isEmail ? match.index : match.index + match[0].length - raw.length;
        if (start >= fromIndex) {
          const email = isEmail || (!isScheme && source[start - 1] === '@' && !raw.includes('/'));
          out.push({
            raw,
            start,
            end: match.index + match[0].length,
            bare: bare && !(email && /^www\./i.test(raw)),
            email,
            priority,
            isScheme,
          });
        }
        if (re.lastIndex === match.index) re.lastIndex += 1;
      }
    }
    return out;
  }
  const matches = collectMatches(body, 0);
  matches.sort((a, b) => a.start - b.start || a.priority - b.priority);
  let consumedEnd = 0;
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (match.start < consumedEnd) continue;
    const { text, hasMalformedTail } = stripTrailInfo(match.raw);
    const url = parseHttpUrl(text);
    if (!url) {
      if (match.isScheme) {
        const tailOffset = unparsedSchemeTailOffset(match.raw);
        if (tailOffset > 0) {
          consumedEnd = match.end;
          if (unparsedTails) {
            unparsedTails.push({ start: match.start + tailOffset, end: match.end });
          }
        }
      }
      continue;
    }
    const end = match.end - (match.raw.length - text.length);
    const rawEnd = hasMalformedTail ? match.end : end;
    add({
      url,
      bare: match.bare,
      email: match.email,
      start: match.start,
      end,
      rawEnd,
    });
    consumedEnd = hasMalformedTail ? match.end : end;
    if (!hasMalformedTail && end < match.end) {
      const nested = collectMatches(body.slice(0, match.end), end);
      if (nested.length) {
        const tail = matches
          .slice(i + 1)
          .concat(nested)
          .sort((a, b) => a.start - b.start || a.priority - b.priority);
        matches.splice(i + 1, matches.length - (i + 1), ...tail);
      }
    }
  }
  return found;
}

function extractUrlCandidates(text, deduplicate = true) {
  return extractUrlCandidatesFromNormalized(normalizeIdeographicHosts(text), deduplicate);
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
  const destHost = hostnameOf(url.hostname);
  const labels = [];
  const user = decodePart(url.username);
  if (user) {
    const userHost = hostnameOf(user);
    if (!destHost || userHost !== destHost) {
      labels.push(...user.split(/[.@]/));
    }
  }
  const pass = decodePart(url.password);
  if (pass) {
    for (const segment of pass.split('@')) {
      if (!segment.includes('.')) continue;
      if (destHost && hostnameOf(segment) === destHost) continue;
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

function lookalikeMatchKind(candidate) {
  if (candidate && candidate.email) return 'email_host';
  if (candidate && userinfoLooksLikeBrand(candidate.url)) return 'url_credentials';
  return 'url_host';
}

function heuristicEnabled(env = process.env) {
  const v = env.HEURISTIC_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

/**
 * Link rules: maintained malicious-host list, then brand lookalike.
 * All hits go through masked LLM review; no link rule archives without AI.
 * Text tropes (OTP, 轉數快, 封號, 順豐清關) and short links go to masked AI review.
 */
function matchObviousScam(text, env = process.env) {
  if (!heuristicEnabled(env)) {
    return { hit: false, id: null, archiveReason: null };
  }
  return matchLinkScam(text);
}

function isCuratedMaliciousHit(heuristic) {
  return Boolean(
    heuristic &&
      heuristic.hit &&
      (heuristic.id === 'malicious_host' || heuristic.id === 'malicious_email_host'),
  );
}

function matchLinkScam(text) {
  const body = text == null ? '' : String(text).normalize('NFKC');
  if (!body.trim()) return { hit: false, id: null, archiveReason: null };
  const candidates = extractUrlCandidates(body);
  if (!candidates.length) return { hit: false, id: null, archiveReason: null };
  const { matchMaliciousHostInCandidates } = require('./malicious-hosts');
  const malicious = matchMaliciousHostInCandidates(candidates);
  if (malicious.hit) return malicious;
  const lookalike = candidates.find(
    (candidate) =>
      (!candidate.bare || hasCommonTld(candidate.url.hostname)) &&
      isLookalike(candidate.url),
  );
  if (lookalike) {
    return {
      hit: true,
      id: 'lookalike_domain',
      archiveReason: null,
      matchKind: lookalikeMatchKind(lookalike),
    };
  }
  // Weakest signal last: a feed hit never preempts curated or lookalike hits, so
  // review cards keep the more specific explanation.
  const feedMatched = feedHostMatchInCandidates(candidates);
  if (feedMatched) {
    return { hit: true, id: 'threat_feed_host', matchedHost: feedMatched, archiveReason: null };
  }
  return { hit: false, id: null, matchedHost: null, archiveReason: null };
}

/**
 * First host in the candidates on the PhishTank snapshot, if any. A feed hit is
 * review evidence only — it never archives or blocks by itself, so a filtering
 * mistake in a third-party feed cannot cost a legitimate chat.
 */
function feedHostMatchInCandidates(candidates) {
  try {
    const { loadFeedHosts, hostMatchesFeed } = require('./malicious-hosts');
    const feedHosts = loadFeedHosts();
    if (!feedHosts.length) return null;
    for (const { url, email } of candidates) {
      if (email) continue;
      const matched = hostMatchesFeed(url.hostname, feedHosts);
      if (matched) return matched;
    }
  } catch {
    return null;
  }
  return null;
}

function feedHostHitsInText(text) {
  const candidates = extractUrlCandidates(text == null ? '' : String(text));
  return feedHostMatchInCandidates(candidates);
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
  // The scan stops at the first strong delimiter: whitespace, quotes,
  // brackets or CJK. A mask token glued behind authority remnants (`.`, `_`)
  // still counts — but a token after the closing quote of a cited link does
  // not, because the quote already proves the host boundary in the original.
  let authorityEnd = wordEnd;
  for (let i = authorityStart; i < raw.length && i < wordEnd + 64; i += 1) {
    const ch = raw[i];
    if (/[\s\]\u3000[「」『』“”"'〈〉《》(){}，。、；：！？\u3400-\u9fff\uf900-\ufaff]/.test(ch)) {
      authorityEnd = Math.min(authorityEnd, i);
      break;
    }
  }
  for (const mark of ['/', '?', '#']) {
    const at = raw.indexOf(mark, authorityStart);
    if (at >= 0 && at < authorityEnd) authorityEnd = at;
  }
  const authorityBeforeHost = raw.slice(authorityStart, hostStart);
  const afterLastAt = authorityBeforeHost.slice(authorityBeforeHost.lastIndexOf('@') + 1);
  return MASK_TOKEN_RE.test(afterLastAt) || MASK_TOKEN_RE.test(raw.slice(hostEnd, authorityEnd));
}

function officialHostTerminatesCleanly(rawAfter) {
  let rest = rawAfter;
  if (rest.startsWith('.') && (rest.length === 1 || /^[/?#\\]/.test(rest[1]))) {
    rest = rest.slice(1);
  }
  const portMatch = /^:(\d+)(?![0-9])/.exec(rest);
  if (portMatch) {
    if (!isValidPort(portMatch[1])) return false;
    rest = rest.slice(portMatch[0].length);
  }
  if (!rest) return true;
  if (/^[/?#\\]/.test(rest)) return true;
  if (/^"(?=$|[,}\]])/.test(rest)) return true;
  if (/^[),.;!?>'"，。｡！？、；：”’」』】》〉）］｝*_~\x60}\]]+$/.test(rest)) return true;
  if (/^[…—–·]+$/.test(rest)) return true;
  if (
    /^[，。｡！？、；：」』】》〉”’）］｝,!;:)…—–·>][\u3400-\u9fff\uf900-\ufaff，。｡！？、；：」』】》〉”’‘“（）【】《》〈〉—–…·）］｝,!;:)>]+$/.test(
      rest,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Where each link to a brand's own domain (the allowlist) names that domain, as offsets into
 * `text`. A link is left out unless `text` has the domain at exactly that place, so the offsets
 * never cover anything but the domain.
 */
function officialHosts(text) {
  const raw = String(text || '');
  const found = [];
  const emailLocalSpans = [];
  for (const match of raw.matchAll(EMAIL_RE)) {
    const localEnd = match.index + match[0].length - match[1].length - 1;
    if (localEnd > match.index) emailLocalSpans.push({ start: match.index, end: localEnd });
  }
  // Each word is normalised on its own, so a `…` elsewhere in the message cannot move a domain.
  for (const word of raw.matchAll(/\S+/g)) {
    const wordEnd = word.index + word[0].length;
    const body = normalizeIdeographicHosts(word[0]);
    for (const { url, start, end } of extractUrlCandidates(body, false)) {
      const host = url.hostname.replace(/\.$/, '');
      if (!isAllowlistedHost(host) || userinfoLooksLikeBrand(url)) continue;
      const [lead, scheme] = /^([a-z][a-z0-9+.-]*:\/\/)?(?:[^/?#@\s]*@)?/i.exec(body.slice(start, end));
      const at = word.index + start + lead.length;
      const until = at + host.length;
      const rawAfter = raw.slice(until, wordEnd);
      // In `https://whatsapp.com。x@evil.com` or `"chan payme.hsbc"@gmail.com` the brand is only part of a login or email.
      const login = (scheme ? /^[^\s/?#\\"]*@/ : /^["\w.+。｡．-]*@/).test(rawAfter);
      const inQuotedEmail =
        /^(?:[^"\\\s]|\\.)*"@/.test(rawAfter) ||
        emailLocalSpans.some((span) => at < span.end && until > span.start);
      const exact = raw.slice(at, until).toLowerCase() === host;
      // A host glued to a mask token (`<PII_1>`), or separated from one only by
      // authority remnants such as `.` or `_`, is not vouched: masking ate the
      // original boundary, so the masked text cannot prove the host was official.
      const maskedAuthority = authorityHasMaskToken(raw, word.index, wordEnd, at, until);
      if (
        exact &&
        !login &&
        !inQuotedEmail &&
        !maskedAuthority &&
        raw[at - 1] !== '>' &&
        raw[until] !== '<' &&
        !/[a-z0-9._-]/i.test(raw[at - 1] || '') &&
        officialHostTerminatesCleanly(rawAfter)
      ) {
        found.push({ host, start: at, end: until });
      }
    }
  }
  return found;
}

function authorityPartsInCandidate(raw, { email = false } = {}) {
  if (email) {
    const at = raw.lastIndexOf('@');
    if (at < 0 || at + 1 >= raw.length) return null;
    return {
      userinfoStart: 0,
      userinfoEnd: at,
      hostStart: at + 1,
      hostEnd: raw.length,
      authorityEnd: raw.length,
    };
  }
  const scheme = /^https?:\/\//i.exec(raw);
  const authorityStart = scheme ? scheme[0].length : 0;
  let authorityEnd = raw.length;
  for (const delimiter of ['/', '\\', '?', '#']) {
    const at = raw.indexOf(delimiter, authorityStart);
    if (at >= 0 && at < authorityEnd) authorityEnd = at;
  }
  const authority = raw.slice(authorityStart, authorityEnd);
  const userinfoEndRel = authority.lastIndexOf('@');
  const userinfoEnd = userinfoEndRel >= 0 ? authorityStart + userinfoEndRel : authorityStart;
  const hostStart = userinfoEndRel >= 0 ? userinfoEnd + 1 : authorityStart;
  if (hostStart >= authorityEnd) return null;
  let hostEnd = authorityEnd;
  if (raw[hostStart] === '[') {
    const close = raw.indexOf(']', hostStart + 1);
    if (close >= 0 && close < authorityEnd) hostEnd = close + 1;
  } else {
    const port = raw.indexOf(':', hostStart);
    if (port >= 0 && port < authorityEnd) hostEnd = port;
  }
  return hostEnd > hostStart
    ? { userinfoStart: authorityStart, userinfoEnd, hostStart, hostEnd, authorityEnd }
    : null;
}

function nestedTailCandidateIsHost(candidate) {
  if (!candidate || !candidate.bare) return true;
  const host = hostnameOf(candidate.url.hostname);
  if (isAllowlistedHost(host)) return true;
  const parsed = psl.parse(host);
  return (
    psl.isValid(host) ||
    Boolean(!('error' in parsed) && parsed.listed && parsed.tld === host && host.includes('.'))
  );
}

/**
 * Character ranges containing non-official URL/email hosts. Unknown domains are
 * not personal data, but they are still unsafe prompt content: keep only a
 * device-vouched official domain readable and mask everything else locally.
 */
function nonOfficialHostSpans(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const { nfkc, mapStart, mapEnd } = nfkcWithOffsetMap(raw);
  const body = replaceIdeographicDots(nfkc);
  const official = officialHosts(body);
  const spans = [];

  /** @type {Array<{ start: number, end: number }>} */
  const unparsedTails = [];
  const stack = extractUrlCandidatesFromNormalized(body, false, unparsedTails);
  function pushNested(slice, offset, skipOfficial = true) {
    /** @type {Array<{ start: number, end: number }>} */
    const nestedUnparsed = [];
    for (const nested of extractUrlCandidatesFromNormalized(slice, false, nestedUnparsed)) {
      stack.push({
        ...nested,
        start: offset + nested.start,
        end: offset + nested.end,
        rawEnd: offset + (nested.rawEnd || nested.end),
        maskHost: nestedTailCandidateIsHost(nested),
        skipOfficial,
      });
    }
    for (const tail of nestedUnparsed) {
      if (tail.start < tail.end) {
        pushNested(slice.slice(tail.start, tail.end), offset + tail.start, skipOfficial);
      }
    }
  }
  for (const tail of unparsedTails) {
    if (tail.start < tail.end) {
      pushNested(body.slice(tail.start, tail.end), tail.start);
    }
  }

  while (stack.length) {
    const cand = stack.pop();
    const candidateText = body.slice(cand.start, cand.end);
    const parts = authorityPartsInCandidate(candidateText, { email: cand.email });
    if (!parts) continue;
    const hostStart = cand.start + parts.hostStart;
    const hostEnd = cand.start + parts.hostEnd;
    if (
      cand.maskHost !== false &&
      hostStart >= 0 &&
      hostEnd > hostStart &&
      hostEnd <= mapEnd.length &&
      (cand.skipOfficial || !official.some((hit) => hostStart < hit.end && hostEnd > hit.start))
    ) {
      const start = mapStart[hostStart];
      const end = mapEnd[hostEnd - 1];
      if (end > start) spans.push({ start, end, label: 'url_host' });
    }
    if (cand.email) {
      if (
        candidateText[0] === '"' &&
        parts.userinfoEnd >= 2 &&
        candidateText[parts.userinfoEnd - 1] === '"'
      ) {
        pushNested(candidateText.slice(1, parts.userinfoEnd - 1), cand.start + 1);
      }
      continue;
    }
    if (parts.userinfoEnd > parts.userinfoStart) {
      pushNested(
        candidateText.slice(parts.userinfoStart, parts.userinfoEnd),
        cand.start + parts.userinfoStart,
      );
    }
    const tailStart = cand.start + parts.authorityEnd;
    const tailEnd = Math.max(cand.end, cand.rawEnd || cand.end);
    if (tailStart < tailEnd) {
      pushNested(body.slice(tailStart, tailEnd), tailStart);
    }
  }
  return spans;
}

/**
 * Character ranges in `text` that contain a curated malicious host (URL or email),
 * so outbound LLM prompts mask listed hostnames with XXX instead of disclosing them.
 */
function curatedMaliciousSpans(text, options = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const { loadMaliciousHosts, hostMatchesMalicious } = require('./malicious-hosts');
  const hosts =
    options.hosts ||
    loadMaliciousHosts(options.dataPath || process.env.MALICIOUS_HOSTS_PATH);
  if (!hosts.length) return [];

  const { nfkc, mapStart, mapEnd } = nfkcWithOffsetMap(raw);
  const body = replaceIdeographicDots(nfkc);
  const spans = [];
  for (const cand of extractUrlCandidatesFromNormalized(body, false)) {
    if (!hostMatchesMalicious(cand.url.hostname, hosts)) continue;
    if (cand.start < 0 || cand.end <= cand.start || cand.end > mapEnd.length) continue;
    const start = mapStart[cand.start];
    let end = mapEnd[cand.end - 1];
    const cjkStop = raw.slice(start, end).search(/[，；！？、（）「」『』【】]/);
    if (cjkStop > 0) {
      const trimmed = raw.slice(start, start + cjkStop);
      if (extractUrlCandidates(trimmed, false).some((c) => hostMatchesMalicious(c.url.hostname, hosts))) {
        end = start + cjkStop;
      }
    }
    if (end > start) {
      spans.push({ start, end, label: 'malicious_host', replacement: 'XXX' });
    }
  }
  return spans;
}

module.exports = {
  ALLOWED_SUFFIXES,
  PUBLIC_HOST_SUFFIXES,
  BRANDS,
  COMMON_TLDS,
  extractUrlCandidates,
  extractUrls,
  hostnameOf,
  isAllowlistedHost,
  isLookalike,
  officialHosts,
  nonOfficialHostSpans,
  curatedMaliciousSpans,
  heuristicEnabled,
  isCuratedMaliciousHit,
  matchObviousScam,
  matchLinkScam,
  feedHostMatchInCandidates,
  feedHostHitsInText,
};
