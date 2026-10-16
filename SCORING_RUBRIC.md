# Decision rubric (mask → LLM primary)

**Live product (2026-10-16):** inbound 1:1 DMs are judged by **mask → OpenAI-compatible LLM** (`lib/llm-review.js`). The local jevlike worker provides **`POST /v1/mask` only** on the default path. There is no LightJev / `model_v2` path.

Link heuristics (`lib/link-rules.js`) and the malicious-host list still run **before** the LLM. End-to-end order: [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented).

Machine-readable thresholds in [scoring-rubric.json](scoring-rubric.json) remain for **lab / legacy jevlike score evals** (`scripts/review-eval.js`, `lib/score-message.js`). They do **not** drive live archive/block anymore.

## Primary path (default)

| Step | Condition | Action |
|------|-----------|--------|
| 1 | Lookalike host, soliciting short link, or malicious-host URL on the **current** message | Archive `obvious_scam` (skip LLM). |
| 2 | Else | `POST /v1/mask` → masked body → LLM (`LLM_REVIEW_*`, **required**). |
| 3 | LLM `scam` / `should_archive` | Archive `llm_review_scam`. |
| 4 | LLM `not_scam` | Ignore. |
| 5 | Mask failure, LLM disabled, LLM error, or `unknown` | **Ignore** (fail closed — no score fallback). |

After archive, **unsaved** contacts **block** only when the current message matched `data/malicious-hosts.json` (`封鎖·惡意域名`). Saved contacts are never auto-blocked. Lookalike and short-link hits do not block.

Optional fork: `CONTEXT_LLM_ENABLED=1` replaces the single-message LLM with a masked multi-message transcript (`lib/context-llm.js`). Same mask requirement; model `block` is treated as archive only.

## Required env (LLM)

Set at least:

- `LLM_REVIEW_API_URL` — OpenAI-compatible base (e.g. `https://api.openai.com/v1` or local `http://127.0.0.1:8081/v1`)
- `LLM_REVIEW_API_KEY` — optional for local servers without auth
- `LLM_REVIEW_MODEL` — e.g. `gpt-4o-mini` or a hosted Cantonese-capable model
- `JEVLIKE_MASK_CKPT` / loaded PII head — without `/v1/mask`, **no** LLM call

`LLM_REVIEW_ENABLED` defaults to **true**. Set `false` only for debugging (everything non-heuristic stays ignore).

## Link backup (archive only)

See [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) and the previous link-rule section in git history. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關) are **not** hard hits.

## Legacy jevlike score (lab only)

The frozen-encoder head (`jevlike_hf_chinese_roberta_r1.pt`) and `POST /v1/score` remain in the repo for **offline evaluation** and training artifacts. **`score = P(scam) × 100`** with `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` is documented in [scoring-rubric.json](scoring-rubric.json) and `lib/score-message.js` but is **not** the live product bar after 2026-10-16.

Historical HK-set numbers (366 rows) described jevlike archive false-positive rates; do not treat them as the LLM product guarantee until measured with `scripts/review-eval.js --llm live` on a labelled corpus.
