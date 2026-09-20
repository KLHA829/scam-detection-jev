'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeForMatch } = require('./cjk-fold');

const DEFAULT_CORPUS_PATH = path.join(
  __dirname,
  '..',
  'data',
  'scam-examples-zh-yue.jsonl',
);
const DEFAULT_THRESHOLD = 0.35;
const STRONG_TAGS = new Set([
  'otp_harvest',
  'fps',
  'usdt',
  'wallet',
  'impersonation_authority',
  'fake_official',
  'parcel_customs',
  'customs',
  'phishing_link',
  'banking',
  'deposit',
  'prize_job',
  'crypto_romance',
]);

const cache = new Map();

function ragEnabled(env = process.env) {
  const v = env.RAG_ENABLED;
  if (v == null || v === '') return true;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function ragThreshold(env = process.env) {
  const raw = env.RAG_THRESHOLD;
  if (raw == null || raw === '') return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_THRESHOLD;
}

function resolveCorpusPath(env = process.env) {
  const p = env.RAG_CORPUS_PATH;
  if (p == null || p === '') return DEFAULT_CORPUS_PATH;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function extractTags(text) {
  const t = text == null ? '' : String(text);
  const tags = new Set();
  if (/(驗證碼|验证码|轉移代碼|转移代码|轉移碼|转移码|\botp\b|verification\s*code)/i.test(t)) {
    tags.add('otp_harvest');
  }
  if (/(轉數快|转数快|\bfps\b)/i.test(t)) tags.add('fps');
  if (/(usdt|bitcoin|\bbtc\b)/i.test(t)) tags.add('usdt');
  if (/(wallet|錢包|钱包)/i.test(t)) tags.add('wallet');
  if (
    /(公安|警察|警方|派出所|海關|海关|入境處|入境处|廉署|\bicac\b|稅務|税务|國安|国安)/i.test(
      t,
    )
  ) {
    tags.add('impersonation_authority');
  }
  if (/(銀行|银行|\bbank\b)/i.test(t)) tags.add('banking');
  if (/(https?:\/\/|www\.|\bbit\.ly\b)/i.test(t)) tags.add('phishing_link');
  if (
    /whatsapp/i.test(t) &&
    /(官方|安全中心|虛假註冊|虚假注册|封號|封号|停用|暫停|暂停)/.test(t)
  ) {
    tags.add('fake_official');
  }
  if (/(清關|清关|關稅|关税|包裹|順豐|顺丰)/.test(t)) {
    tags.add('parcel_customs');
    tags.add('customs');
  }
  if (/(兼職|兼职|招聘|日結|日结)/.test(t)) tags.add('prize_job');
  if (/(保證金|保证金|押金)/.test(t)) tags.add('deposit');
  if (/(交易所|套利|返利|分紅|分红)/.test(t)) tags.add('crypto_romance');
  if (/(立即|立刻|即刻|急住|馬上|马上|就快)/.test(t)) tags.add('urgency');
  if (/(不要告訴|不要告诉|唔好同任何人|別告訴|别告诉)/.test(t)) {
    tags.add('secrecy');
  }
  if (/(換咗號碼|换了号码|新號碼|新号码)/.test(t)) tags.add('new_number');
  return tags;
}

function ngrams(s, n) {
  const compact = String(s).replace(/\s+/g, '');
  const grams = new Set();
  if (compact.length < n) {
    if (compact) grams.add(compact);
    return grams;
  }
  for (let i = 0; i <= compact.length - n; i += 1) {
    grams.add(compact.slice(i, i + n));
  }
  return grams;
}

function tokenize(s) {
  const tokens = new Set();
  const latin = String(s).match(/[a-z0-9]+/g) || [];
  for (const w of latin) tokens.add(w);
  const cjk = String(s).match(/[\u3400-\u9fff]/g) || [];
  for (const ch of cjk) tokens.add(ch);
  return tokens;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  return inter / (a.size + b.size - inter);
}

function indexText(text) {
  const norm = normalizeForMatch(text);
  return {
    norm,
    tokens: tokenize(norm),
    bi: ngrams(norm, 2),
    tri: ngrams(norm, 3),
    tags: extractTags(text),
  };
}

function similarity(a, b) {
  const tri = jaccard(a.tri, b.tri);
  const bi = jaccard(a.bi, b.bi);
  const tok = jaccard(a.tokens, b.tokens);
  return 0.5 * tri + 0.3 * bi + 0.2 * tok;
}

function tagOverlap(a, b) {
  const out = [];
  for (const tag of a) {
    if (b.has(tag)) out.push(tag);
  }
  return out;
}

function isStrongTagOverlap(overlap) {
  if (overlap.length < 2) return false;
  return overlap.some((tag) => STRONG_TAGS.has(tag));
}

function parseJsonl(raw) {
  const examples = [];
  for (const line of String(raw).split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed);
    if (!row || !row.id || !row.text) continue;
    examples.push({
      id: row.id,
      lang: row.lang || null,
      text: row.text,
      tags: new Set(Array.isArray(row.tags) ? row.tags : []),
      source: row.source || null,
      index: indexText(row.text),
    });
  }
  return examples;
}

function loadCorpus(env = process.env) {
  const pathname = resolveCorpusPath(env);
  const hit = cache.get(pathname);
  if (hit) return hit;
  const raw = fs.readFileSync(pathname, 'utf8');
  const examples = parseJsonl(raw);
  cache.set(pathname, examples);
  return examples;
}

function clearCorpusCache() {
  cache.clear();
}

function noHit(extra = {}) {
  return {
    hit: false,
    id: null,
    archiveReason: null,
    score: 0,
    tags: [],
    ...extra,
  };
}

function matchRagScam(text, env = process.env) {
  if (!ragEnabled(env)) return noHit();
  const body = text == null ? '' : String(text);
  if (!body.trim()) return noHit();

  let corpus;
  try {
    corpus = loadCorpus(env);
  } catch {
    return noHit({ error: 'corpus_unreadable' });
  }
  if (!corpus.length) return noHit();

  const query = indexText(body);
  const threshold = ragThreshold(env);
  let best = null;

  for (const ex of corpus) {
    const score = similarity(query, ex.index);
    const overlap = tagOverlap(query.tags, ex.tags);
    const strong = isStrongTagOverlap(overlap);
    const lexicalOk = score >= threshold * 0.35 || overlap.length >= 3;
    const wouldHit = score >= threshold || (strong && lexicalOk);
    const rank = score + overlap.length * 0.04;
    if (!best || rank > best.rank) {
      best = {
        id: ex.id,
        score,
        overlap,
        strong,
        wouldHit,
        rank,
      };
    }
  }

  if (!best || !best.wouldHit) {
    return noHit({
      score: best ? best.score : 0,
      nearestId: best ? best.id : null,
    });
  }

  return {
    hit: true,
    id: best.id,
    archiveReason: 'rag_scam_match',
    score: Number(best.score.toFixed(4)),
    tags: best.overlap,
  };
}

module.exports = {
  DEFAULT_CORPUS_PATH,
  DEFAULT_THRESHOLD,
  ragEnabled,
  ragThreshold,
  resolveCorpusPath,
  extractTags,
  indexText,
  similarity,
  loadCorpus,
  clearCorpusCache,
  matchRagScam,
};
