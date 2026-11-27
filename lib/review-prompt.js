'use strict';

const { HEURISTIC_CONTACT_LABELS } = require('./block-policy');
const { extractJsonObject } = require('./llm-review');

const SETUP_POLL_NAME = '呢個 bot 點處理可疑訊息？';
const REVIEW_POLL_NAME = '你想點處理？';
const UNBLOCK_POLL_NAME = '要唔要解除封鎖？';
const GUIDE_UNAVAILABLE = '解釋暫時出唔到';

const SETUP_INTRO = [
  '第一次設定。未揀之前，陌生人嘅可疑訊息最多只會封存，唔會封鎖。',
  '已儲存聯絡人嘅可疑訊息會轉發嚟呢度，等你決定。揀「逐條問我」就所有可疑訊息都問你。解釋會先遮走個人資料，再送到你設定嘅 chat API。',
  '每次封鎖或封存之後，呢度都會收到左邊個名、電話同原因。電話同顯示名只係喺呢部機拼上去，唔會送去 chat API。揀一次就記住。想改打「設定」。',
].join('\n');

const SETUP_OPTIONS = [
  { id: 'auto', label: '自動封鎖同封存' },
  { id: 'guided', label: '逐條問我' },
];

const REVIEW_OPTIONS = [
  { id: 'block', label: '封鎖並封存' },
  { id: 'archive', label: '只封存' },
  { id: 'leave', label: '留低' },
];

const UNBLOCK_OPTIONS = [
  { id: 'unblock', label: '解除封鎖' },
  { id: 'keep', label: '保持封鎖' },
];

const ARCHIVE_REASON_LINES = {
  jevlike_score: '評分達到封存線',
  llm_review_scam: '覆核模型認為要封存',
  context_llm: '上文覆核認為要封存',
};

const GUIDE_SYSTEM_PROMPT = [
  'You explain one suspicious WhatsApp chat to the account owner, in Cantonese.',
  'The transcript is already desensitised. Personal data is XXX. Do not reconstruct names, phones, accounts, IDs, or codes.',
  'Reply with ONE JSON object and no extra keys: {"guide":"string"}',
  'guide is 2 to 4 short Cantonese sentences: which line looks wrong, what the lure may be, and how the owner can check without sending a code or money.',
  'Do not tell them to block, archive, or ignore. Do not name a button. Do not say you are certain.',
].join(' ');

function optionLabels(options) {
  return options.map((option) => option.label);
}

function matchOption(options, text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const numbered = raw.match(/^([123])(?:[.、\s].*)?$/);
  const token = numbered ? numbered[1] : raw;
  const index = Number(token);
  if (String(index) === token && index >= 1 && index <= options.length) {
    return options[index - 1].id;
  }
  const found = options.find((option) => option.label === raw);
  return found ? found.id : null;
}

function parseSetupChoice(text) {
  return matchOption(SETUP_OPTIONS, text);
}

function compactChoiceText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s。！？!?，,、.]/gu, '')
    .replace(/封锁/g, '封鎖')
    .replace(/^唔該/u, '');
}

function parseReviewChoice(text, { loose = false } = {}) {
  const exact = matchOption(REVIEW_OPTIONS, text);
  if (exact) return exact;
  if (!loose) return null;
  const compact = compactChoiceText(text);
  if (!compact) return null;
  if (/唔.{0,3}(?:封|風|风|block)|不要(?:封|風|风)|别(?:封|風|风)|留低|leave/.test(compact)) return 'leave';
  if (/只?(?:封|風|风)存|archive/.test(compact)) return 'archive';
  if (/(?:封|風|风)(?:鎖|锁)|(?:封|風|风)咗佢|(?:封|風|风)佢|block/.test(compact)) return 'block';
  return null;
}

function parseUnblockChoice(text, { loose = false } = {}) {
  const exact = matchOption(UNBLOCK_OPTIONS, text);
  if (exact) return exact;
  if (!loose) return null;
  const compact = compactChoiceText(text);
  if (!compact) return null;
  if (/保持|keep|唔.{0,3}(?:解(?:封|風|风)|解除|unblock)|繼續(?:封|風|风)/.test(compact)) return 'keep';
  if (/解除|解(?:封|風|风)|unblock/.test(compact)) return 'unblock';
  return null;
}

function localFacts({
  decision,
  heuristic,
  savedContact,
  pushName,
  digits,
} = {}) {
  const lines = [];
  const who = [pushName, digits].filter(Boolean).join(' · ');
  if (who) lines.push(who);

  const heuristicId =
    (heuristic && heuristic.hit && heuristic.id) ||
    (decision && decision.heuristicId) ||
    null;
  const heuristicLabel = heuristicId && HEURISTIC_CONTACT_LABELS[heuristicId];
  if (heuristicLabel) lines.push(`句式：${heuristicLabel}`);

  const reason = decision && decision.archiveReason;
  if (reason && reason !== 'obvious_scam') {
    lines.push(ARCHIVE_REASON_LINES[reason] || `原因：${reason}`);
  }

  if (savedContact === true) {
    lines.push('已儲存聯絡人，唔會自動封存或封鎖，等你決定');
  } else if (savedContact === null) {
    lines.push('未能確認聯絡人是否已儲存，等你決定');
  } else if (decision && decision.action === 'block') {
    lines.push('未儲存聯絡人，原本會封鎖並封存');
  } else {
    lines.push('未儲存聯絡人，原本只會封存，唔會封鎖');
  }
  return lines.join('\n');
}

function usableGuide(text) {
  if (typeof text !== 'string') return null;
  const guide = text.trim();
  if (!guide || guide.length > 600) return null;
  if (/@/.test(guide) || /\d{8,}/.test(guide)) return null;
  return guide;
}

function parseGuide(payload) {
  const parsed = extractJsonObject(payload);
  const guide = usableGuide(parsed && parsed.guide);
  if (!guide) return { ok: false, guide: null };
  return { ok: true, guide };
}

function buildReviewCard({ facts, guide } = {}) {
  const explanation = guide ? `模型講解：\n${guide}` : GUIDE_UNAVAILABLE;
  return `${facts || ''}\n\n${explanation}\n\n撳下面揀。模型唔會代你決定。`.trim();
}

module.exports = {
  SETUP_POLL_NAME,
  REVIEW_POLL_NAME,
  SETUP_INTRO,
  SETUP_OPTIONS,
  REVIEW_OPTIONS,
  UNBLOCK_POLL_NAME,
  UNBLOCK_OPTIONS,
  GUIDE_UNAVAILABLE,
  GUIDE_SYSTEM_PROMPT,
  ARCHIVE_REASON_LINES,
  optionLabels,
  parseSetupChoice,
  parseReviewChoice,
  parseUnblockChoice,
  localFacts,
  usableGuide,
  parseGuide,
  buildReviewCard,
};
