#!/usr/bin/env node
'use strict';

/**
 * Offline evaluation against a labelled HK corpus: link heuristics then mask → LLM.
 *
 * Usage:
 *   node scripts/review-eval.js [--from-run fixtures/review-eval-smoke.json] [--split ci_smoke] \
 *   node scripts/review-eval.js --from-run ../jevlike-lab/runs/r1_head_only.json --split real_test \
 *        [--mode off|all] [--llm off|dry|live] [--sample 3]
 *
 *   --mode  off (default: no LLM), all (review every DM except direct blocklist archives)
 *   --llm   off   = no call, merge is skipped        (numbers are meaningful)
 *           dry   = mask with the offline stub, capture the payload, DO NOT send, treat LLM as
 *                   unknown so every number stays honest ("what would have been asked");
 *                   needs no credentials, and exits 1 if any call fails to build a request
 *           live  = with --mode all, POST to LLM_REVIEW_API_URL using the offline stub mask;
 *                   use only data safe to share (needs LLM_REVIEW_API_KEY or OPENAI_API_KEY)
 */

const fs = require('fs');
const path = require('path');

const { decideIncomingAction } = require('../lib/decide-incoming');
const { matchObviousScam } = require('../lib/link-rules');
const { applyBlockPolicy } = require('../lib/block-policy');
const { maskMessagesForLlm } = require('../lib/context-llm');
const { createStubJevlikeClient } = require('../stub-jevlike');
const {
  createLlmReviewConfig,
  shouldTriggerLlmReview,
  reviewRedactedMessage,
  mergeLlmDecision,
  resolveChatCompletionsUrl,
} = require('../lib/llm-review');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM_RUN = arg(
  'from-run',
  path.join(__dirname, '..', 'fixtures', 'review-eval-smoke.json'),
);
const SPLIT = arg('split', 'ci_smoke');
const MODE = arg('mode', 'off');
const LLM = arg('llm', 'off');
const SAMPLE = Number(arg('sample', '3'));

// dry-run never sends, so it needs no credentials; this host is reserved and cannot resolve
const DRY_RUN_API_URL = 'https://llm-review.dry-run.invalid/v1';

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
  if (MODE !== 'off' && MODE !== 'all') {
    throw new Error(`unsupported --mode ${MODE}; expected off or all`);
  }

  const run = JSON.parse(fs.readFileSync(FROM_RUN, 'utf8'));
  const rows = run[SPLIT];
  if (!Array.isArray(rows)) throw new Error(`split ${SPLIT} not in ${FROM_RUN}`);

  const env = process.env;
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
    const text = r.context || '';
    stats.rows += 1;
    if (label === 1) stats.scam += 1; else stats.innocent += 1;

    const heuristic = matchObviousScam(text, env);
    const decision = decideIncomingAction(null, null, false, heuristic);

    // stage 2 — the repo's own trigger + redaction + merge
    const trig = shouldTriggerLlmReview({
      heuristic,
      decision,
      env,
      enabled: MODE === 'all',
    });
    if (trig.trigger) {
      stats.triggered += 1;
      for (const reason of trig.reasons) {
        stats.trigger_reasons[reason] = (stats.trigger_reasons[reason] || 0) + 1;
      }
    }

    let llmReview = null;
    if (trig.trigger && LLM !== 'off') {
      const maskResult = await createStubJevlikeClient().maskMessages([text]);
      const redacted = maskMessagesForLlm([text], maskResult)[0];
      const spanCount = (maskResult.messages[0] && maskResult.messages[0].spans.length) || 0;
      if (redacted !== text) {
        stats.redacted_rows += 1;
        if (samples.redacted.length < SAMPLE * 2) samples.redacted.push({ before: text, after: redacted, kept_local: spanCount });
      }
      stats.called += 1;
      llmReview = await reviewRedactedMessage(redacted, {
        ...cfg,
        env,
        enabled: true,
        fetchImpl,
        ...(LLM === 'dry' && !resolveChatCompletionsUrl(cfg.apiUrl)
          ? { apiUrl: DRY_RUN_API_URL }
          : {}),
      });
      if (!llmReview.ok) stats.failed_transport += 1;
    }

    const merged = llmReview ? mergeLlmDecision(decision, llmReview, { env }) : decision;
    const finalDecision = applyBlockPolicy(merged, {
      savedContact: false,
      heuristic,
      env,
    });
    const flagged = finalDecision.action !== 'ignore';
    const blocked = finalDecision.action === 'block';
    if (finalDecision.released) stats.released_by_llm += 1;

    if (label === 1) {
      if (flagged) stats.tp += 1; else stats.fn += 1;
      if (blocked) stats.scam_blocked += 1;
    } else {
      if (flagged) {
        stats.fp += 1;
        stats.fp_archived += 1;
        if (blocked) stats.fp_blocked += 1;
        if (samples.fp.length < SAMPLE) {
          samples.fp.push({ why: finalDecision.archiveReason, text: text.slice(0, 60) });
        }
      } else {
        stats.tn += 1;
      }
    }
  }

  if (stats.rows === 0) {
    throw new Error(`split ${SPLIT} is empty`);
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
  const innocentRate = stats.innocent
    ? `${((100 * stats.fp) / stats.innocent).toFixed(1)}%`
    : 'n/a';
  line('innocents wrongly flagged', `${stats.fp}/${stats.innocent}  (${innocentRate})`);
  line('...of those would auto-block', stats.fp_blocked);
  line('precision of a flag', prec === null ? '-' : prec.toFixed(3));
  line('accuracy', out.accuracy.toFixed(3));
  line('released back by LLM', stats.released_by_llm);
  line('rows where PII was masked', `${stats.redacted_rows}/${stats.called} calls`);
  line('trigger reasons', JSON.stringify(stats.trigger_reasons));

  if (samples.fp.length) {
    console.log('\n-- 誤封 樣本');
    for (const s of samples.fp) console.log(`   why=${s.why} | ${s.text}`);
  }
  if (samples.redacted.length) {
    console.log('\n-- 遮罩樣本 (本地 mapping 唔會 outbound)');
    for (const s of samples.redacted) console.log(`   ${s.before.slice(0, 44)}  ->  ${s.after.slice(0, 44)}`);
  }
  if (LLM === 'dry') {
    console.log(`\n-- dry run: 建好 ${requests.length} 個 request，冇送出（未計任何判斷）`);
    if (requests[0]) console.log(`   url=${requests[0].url}\n   body=${JSON.stringify(requests[0].body).slice(0, 400)}`);
  }
  if (LLM === 'dry' && requests.length !== stats.called) {
    throw new Error(`dry run built ${requests.length} of ${stats.called} LLM requests`);
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
