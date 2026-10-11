'use strict';

const { HEURISTIC_CONTACT_LABELS } = require('./block-policy');
const { extractJsonObject } = require('./llm-review');

const SETUP_POLL_NAME = '呢個 bot 點處理可疑訊息？';
const REVIEW_POLL_NAME = '你想點處理？';
const GUIDE_UNAVAILABLE = '解釋暫時出唔到';

const SETUP_INTRO = [
  '第一次設定。未揀之前只會封存，唔會封鎖。',
  '揀「逐條問我」之後，可疑訊息會轉發嚟呢度。解釋會先遮走個人資料，再送到你設定嘅 chat API。',
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

const ARCHIVE_REASON_LINES = {
  jevlike_score: '評分達到封存線',
  llm_review_scam: '覆核模型認為要封存',
  context_llm: '上文覆核認為要封存',
  rag_scam_match: '同已知騙案句式相近',
  local_classifier: '本地分類器認為要封存',
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

function parseReviewChoice(text) {
  return matchOption(REVIEW_OPTIONS, text);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function localFacts({
  scoreResult,
  decision,
  heuristic,
  savedContact,
  pushName,
  digits,
  env,
  rubric,
} = {}) {
  const lines = [];
  const who = [pushName, digits].filter(Boolean).join(' · ');
  if (who) lines.push(who);

  const score = finite(scoreResult && scoreResult.score);
  const thresholds = (scoreResult && scoreResult.thresholds) || (rubric && rubric.thresholds) || {};
  const archive = finite(thresholds.archive);
  if (score != null) {
    lines.push(
      `分數 ${Math.round(score)}（封存線 ${Math.round(archive == null ? 42 : archive)}）`,
    );
  }

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

  const saved = savedContact === true;
  if (saved) {
    lines.push('已儲存聯絡人，原本只會封存，唔會封鎖');
  } else if (decision && decision.action === 'block') {
    lines.push('未儲存聯絡人，原本會封鎖並封存');
  } else {
    lines.push('未儲存聯絡人，原本只會封存，唔會封鎖');
  }
  return lines.join('\n');
}

function usableGuide(text) {
  const guide = String(text || '').trim();
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
  GUIDE_UNAVAILABLE,
  GUIDE_SYSTEM_PROMPT,
  ARCHIVE_REASON_LINES,
  optionLabels,
  parseSetupChoice,
  parseReviewChoice,
  localFacts,
  usableGuide,
  parseGuide,
  buildReviewCard,
};
