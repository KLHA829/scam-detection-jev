#!/usr/bin/env node
'use strict';

/**
 * Offline end-to-end evaluation of stage 1 (jevlike score) + stage 2 (redact -> llm-review -> merge)
 * against a labelled real HK corpus. Uses the repo's own modules, not a reimplementation.
 *
 * Usage:
 *   node scripts/review-eval.js --from-run ../jevlike-lab/runs/r1_head_only.json [--split real_test] \
 *        [--mode off|triggers|all] [--llm off|dry|live] [--sample 3]
 *
 *   --mode  stage-2 gating: off (LLM_REVIEW_ENABLED=false), triggers (grey/high/conflict), all (LLM_REVIEW_ALL=1)
 *   --llm   off   = no call, merge is skipped        (numbers are meaningful)
 *           dry   = build + redact the real request, capture the payload, DO NOT send, treat LLM as
 *                   unknown so every number stays honest ("what would have been asked")
 *           live  = actually POST to LLM_REVIEW_API_URL (needs LLM_REVIEW_API_KEY or OPENAI_API_KEY)
 */

const fs = require('fs');
const path = require('path');

const { decideIncomingAction } = require('../lib/decide-incoming');
const { loadRubric, jevlikePayloadToScoreResult } = require('../lib/score-message');
const { redactPii } = require('../lib/redact');
const {
  createLlmReviewConfig,
  shouldTriggerLlmReview,
  reviewRedactedMessage,
  mergeLlmDecision,
} = require('../lib/llm-review');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM_RUN = arg('from-run', path.join(__dirname, '..', '..', 'jevlike-lab', 'runs', 'r1_head_only.json'));
const SPLIT = arg('split', 'real_test');
const MODE = arg('mode', 'triggers');
const LLM = arg('llm', 'off');
const SAMPLE = Number(arg('sample', '3'));

const rubric = loadRubric();

function stage2Env() {
  return {
    ...process.env,
    LLM_REVIEW_ENABLED: MODE === 'off' ? 'false' : 'true',
    LLM_REVIEW_ALL: MODE === 'all' ? '1' : '0',
    LLM_REVIEW_ON_HIGH: process.env.LLM_REVIEW_ON_HIGH || 'true',
  };
}

// dry-run transport: records the outbound request, never sends it, answers `unknown`
function dryTransport(sink) {
  return async (url, init) => {
    sink.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"label":"unknown","reason":"dry-run"}' } }],
        }),
    };
  };
}

async function main() {
  const run = JSON.parse(fs.readFileSync(FROM_RUN, 'utf8'));
  const rows = run[SPLIT];
  if (!Array.isArray(rows)) throw new Error(`split ${SPLIT} not in ${FROM_RUN}`);

  const env = stage2Env();
  const cfg = createLlmReviewConfig(env);
  const requests = [];
  const fetchImpl = LLM === 'dry' ? dryTransport(requests) : undefined;

  const stats = {
    rows: 0, scam: 0, innocent: 0,
    triggered: 0, called: 0, failed_transport: 0,
    tp: 0, fp: 0, fn: 0, tn: 0,
    fp_archived: 0, fp_blocked: 0, scam_blocked: 0,
    released_by_llm: 0, redacted_rows: 0,
    trigger_reasons: {},
  };
  const samples = { fp: [], redacted: [] };

  for (const r of rows) {
    const label = r.label === 1 ? 1 : 0;
    const p = typeof r.p_scam === 'number' ? r.p_scam : 0;
    const text = r.context || '';
    stats.rows += 1;
    if (label === 1) stats.scam += 1; else stats.innocent += 1;

    // stage 1 — the same score object the bot builds from a worker payload
    const scoreResult = jevlikePayloadToScoreResult({ prob_scam: p }, rubric);
    const heuristic = { hit: false };
    const decision = decideIncomingAction(scoreResult, '+85200000000', false, heuristic, null, null);

    // stage 2 — the repo's own trigger + redaction + merge
    const trig = shouldTriggerLlmReview({
      scoreResult, heuristic, rag: null, localClassifier: null,
      text, formattedNumber: '+85200000000', savedContact: false, decision, env,
    });
    if (trig.trigger) {
      stats.triggered += 1;
      for (const reason of trig.reasons) {
        stats.trigger_reasons[reason] = (stats.trigger_reasons[reason] || 0) + 1;
      }
    }

    let llmReview = null;
    if (trig.trigger && LLM !== 'off') {
      const { redacted, mapping } = redactPii(text);
      if (redacted !== text) {
        stats.redacted_rows += 1;
        if (samples.redacted.length < SAMPLE * 2) samples.redacted.push({ before: text, after: redacted, kept_local: mapping.length });
      }
      stats.called += 1;
      llmReview = await reviewRedactedMessage(redacted, {
        ...cfg, env, enabled: true, fetchImpl,
      });
      if (!llmReview.ok) stats.failed_transport += 1;
    }

    const finalDecision = llmReview ? mergeLlmDecision(decision, llmReview, { env }) : decision;
    const flagged = finalDecision.action !== 'ignore';
    if (finalDecision.released) stats.released_by_llm += 1;

    if (label === 1) {
      if (flagged) stats.tp += 1; else stats.fn += 1;
      if (flagged && scoreResult.score >= scoreResult.thresholds.block) stats.scam_blocked += 1;
    } else {
      if (flagged) {
        stats.fp += 1;
        stats.fp_archived += 1;
        if (scoreResult.score >= scoreResult.thresholds.block) stats.fp_blocked += 1;
        if (samples.fp.length < SAMPLE) {
          samples.fp.push({ score: scoreResult.score, why: finalDecision.archiveReason, text: text.slice(0, 60) });
        }
      } else {
        stats.tn += 1;
      }
    }
  }

  const prec = stats.tp + stats.fp ? stats.tp / (stats.tp + stats.fp) : null;
  const rec = stats.tp + stats.fn ? stats.tp / (stats.tp + stats.fn) : null;
  const out = {
    head: path.basename(FROM_RUN, '.json'),
    split: SPLIT,
    mode: MODE,
    llm: LLM,
    model: cfg.model,
    api_url_set: Boolean(cfg.apiUrl),
    stats,
    precision: prec,
    recall: rec,
    accuracy: (stats.tp + stats.tn) / stats.rows,
  };

  const line = (k, v) => console.log(`${k.padEnd(34)} ${v}`);
  console.log(`\n=== ${out.head} | ${SPLIT} | stage2=${MODE} | llm=${LLM} | model=${out.model} ===`);
  line('rows / scam / innocent', `${stats.rows} / ${stats.scam} / ${stats.innocent}`);
  line('stage2 triggered', `${stats.triggered} (${((100 * stats.triggered) / stats.rows).toFixed(1)}%)`);
  line('LLM calls made', stats.called);
  line('LLM transport failures (=unknown)', stats.failed_transport);
  line('scams caught / missed', `${stats.tp} / ${stats.fn}  recall=${rec === null ? '-' : rec.toFixed(3)}`);
  line('innocents wrongly flagged', `${stats.fp}/${stats.innocent}  (${((100 * stats.fp) / stats.innocent).toFixed(1)}%)`);
  line('...of those would auto-block', stats.fp_blocked);
  line('precision of a flag', prec === null ? '-' : prec.toFixed(3));
  line('accuracy', out.accuracy.toFixed(3));
  line('released back by LLM', stats.released_by_llm);
  line('rows where PII was masked', `${stats.redacted_rows}/${stats.called} calls`);
  line('trigger reasons', JSON.stringify(stats.trigger_reasons));

  if (samples.fp.length) {
    console.log('\n-- 誤封 樣本');
    for (const s of samples.fp) console.log(`   score=${s.score} why=${s.why} | ${s.text}`);
  }
  if (samples.redacted.length) {
    console.log('\n-- 遮罩樣本 (本地 mapping 唔會 outbound)');
    for (const s of samples.redacted) console.log(`   ${s.before.slice(0, 44)}  ->  ${s.after.slice(0, 44)}`);
  }
  if (LLM === 'dry') {
    console.log(`\n-- dry run: 建好 ${requests.length} 個 request，冇送出（未計任何判斷）`);
    if (requests[0]) console.log(`   url=${requests[0].url}\n   body=${JSON.stringify(requests[0].body).slice(0, 400)}`);
  }
  if (LLM === 'live') {
    console.log('\n注意：live 模式嘅數字取決於你用邊個 model，需自行記錄 model id 同呼叫數。');
  }

  const outPath = arg('out', null);
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ ...out, requests: requests.length }, null, 2));
    console.log(`\n寫入 ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
