'use strict';

const {
  hasSavedContactMoneyWarnSignal,
  hasMoneyTopicMention,
  hasUrgentMoneyAsk,
} = require('./scam-intent');

const MIN_PRIOR_FOR_ANOMALY = 2;
const MAX_PRIOR_MONEY_RATIO = 0.15;

/**
 * Feature 2: sudden urgent money ask when prior inbound rarely mentions money.
 * Requires thread/history evidence; without enough prior lines, returns anomaly false
 * (Feature 1 ordinary warn still applies via hasSavedContactMoneyWarnSignal).
 */
function assessAbnormalFinanceUrgency({ priorBodies, currentBody } = {}) {
  const prior = (Array.isArray(priorBodies) ? priorBodies : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  const current = String(currentBody || '').trim();
  if (!current || !hasUrgentMoneyAsk(current)) {
    return { anomaly: false, priorCount: prior.length, priorMoneyCount: 0 };
  }
  if (prior.length < MIN_PRIOR_FOR_ANOMALY) {
    return { anomaly: false, priorCount: prior.length, priorMoneyCount: 0, degraded: true };
  }
  const priorMoneyCount = prior.filter((line) => hasMoneyTopicMention(line)).length;
  const ratio = priorMoneyCount / prior.length;
  if (priorMoneyCount === 0 || ratio <= MAX_PRIOR_MONEY_RATIO) {
    return {
      anomaly: true,
      priorCount: prior.length,
      priorMoneyCount,
      reasons: ['sudden_urgent_money'],
    };
  }
  return { anomaly: false, priorCount: prior.length, priorMoneyCount };
}

function evaluateSavedMoneyWarn({
  savedContact,
  body,
  priorBodies,
} = {}) {
  if (savedContact !== true) {
    return { shouldWarn: false, kind: null, elevated: false };
  }
  const current = String(body || '').trim();
  if (!hasSavedContactMoneyWarnSignal(current)) {
    return { shouldWarn: false, kind: null, elevated: false };
  }
  const finance = assessAbnormalFinanceUrgency({ priorBodies, currentBody: current });
  const elevated = Boolean(finance.anomaly);
  return {
    shouldWarn: true,
    kind: elevated ? 'abnormal_finance' : 'saved_money_ask',
    elevated,
    finance,
  };
}

/**
 * Saved contacts: money-warn path never archive/block. Strip LLM/heuristic archive
 * when a saved money warn is active (link hard-hit archives still run first).
 */
function applySavedMoneyWarnGuard(decision, moneyWarn, heuristic) {
  if (!moneyWarn || !moneyWarn.shouldWarn || !decision) return decision;
  if (heuristic && heuristic.hit) return decision;
  if (decision.action === 'archive' || decision.action === 'block') {
    return {
      action: 'ignore',
      archiveReason: null,
      moneyWarnSuppressedArchive: true,
      priorArchiveReason: decision.archiveReason,
    };
  }
  return decision;
}

function buildMoneyWarnNotice({
  listName,
  digits,
  kind,
  elevated,
} = {}) {
  const name = String(listName || '').trim() || '未知';
  const phone = String(digits || '').trim();
  const lines = [];
  if (elevated || kind === 'abnormal_finance') {
    lines.push('【異常財務請求提示】');
    lines.push(
      '呢位熟人平時好少講錢，突然催你轉賬或借錢，請提高警覺。',
    );
  } else {
    lines.push('【熟人借錢／轉賬提示】');
    lines.push('儲存咗嘅聯絡人向你提出借錢或轉賬，請先核實身份。');
  }
  lines.push('建議直接打電話或當面確認，唔好只靠 WhatsApp 文字就過數。');
  lines.push('呢個提示只係提醒你，唔會封存或封鎖對話。');
  lines.push('');
  lines.push(`左邊：${name}`);
  lines.push(phone ? `電話：${phone}` : '電話未解析到');
  lines.push('');
  lines.push('下面可以揀「知道了」或「略過」。');
  return lines.join('\n');
}

module.exports = {
  MIN_PRIOR_FOR_ANOMALY,
  assessAbnormalFinanceUrgency,
  evaluateSavedMoneyWarn,
  applySavedMoneyWarnGuard,
  buildMoneyWarnNotice,
};
