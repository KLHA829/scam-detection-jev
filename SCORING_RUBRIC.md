# Decision rubric (reference)

Facts about live decisions and lab-only jevlike thresholds. Setup and env wiring: [README.md](README.md). Rationale: [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md). Machine-readable lab numbers: [scoring-rubric.json](scoring-rubric.json).

**Live product:** inbound 1:1 DMs use link heuristics, then **`POST /v1/mask`**, then an OpenAI-compatible LLM (`lib/llm-review.js` or `lib/context-llm.js`). **`POST /v1/score`** does not run on the inbound path.

## Live path summary

| Stage | Trigger | Archive reason | Block |
|-------|---------|----------------|-------|
| Known malicious URL | Blocklisted URL on **current** message, subject to the warning-only exception below | `obvious_scam` without AI | Unsaved + malicious-host match only |
| Blocklisted email domain | Email address with a listed host on **current** message, subject to the warning-only exception below | `obvious_scam` without AI | Never |
| Keyword or link rule | Lookalike or soliciting short link | Mask → AI; no rule-only archive | Never from the rule |
| Context LLM (default) | `CONTEXT_LLM_ENABLED` on (default when unset); not skipped by a direct archive | `context_llm` when model says `archive` or `block` with sufficient confidence | Never from LLM |
| Primary LLM | `CONTEXT_LLM_ENABLED=0` or `false` | `llm_review_scam` only when label is `scam` and confidence meets `LLM_REVIEW_MIN_CONFIDENCE` (default 0.7) | Never from LLM |
| No action | `not_scam`, `no_action`, low confidence, mask failure, LLM off or unavailable, error, `unknown` | None | None |

End-to-end order: [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented).

### Confidence and cooldown

| Symbol | Default | Effect |
|--------|---------|--------|
| `LLM_REVIEW_MIN_CONFIDENCE` | `0.7` | Archive from LLM only when `confidence` is at or above this value |
| `LLM_REVIEW_COOLDOWN_MS` | `600000` (10 min) | After successful LLM review (`ok === true`), skip mask and LLM for same `chatId` |
| `CONTEXT_LLM_MESSAGES` | `10` | Inbound bodies in context transcript (current message included) |

`LLM_REVIEW_ENABLED` defaults to **true**. `CONTEXT_LLM_ENABLED` defaults to **on** when unset.

### Block policy (live)

| Contact | Malicious-host URL on current message | Blocklisted email | Lookalike or soliciting short link |
|---------|--------------------------------------|-------------------|-------------------------|
| Unsaved | May **block** (`封鎖·惡意域名`) after archive | Archive only | AI review only; never auto-block |
| Saved | Never auto-block | Archive only | AI review only; never auto-block |

Warning-only scam reports go to **mask → LLM** before malicious-host, lookalike and short-link rules, regardless of saved status or forwarding metadata. They require scam framing, no direct solicitation outside quoted/reported/negated speech, and exactly one hard-hit URL occurrence. Extra genuine-site references are fine; direct asks, repeated flagged URLs and second flagged links retain normal link rules. The review can archive, but cannot auto-block; normal mask, enablement and cooldown rules apply.

List file: [`data/malicious-hosts.json`](data/malicious-hosts.json). Optional path override: `MALICIOUS_HOSTS_PATH`. Empty `hosts:[]` keeps the previous list unless `MALICIOUS_HOSTS_ALLOW_EMPTY=1`.

### Link rules (not phrase tropes)

Implemented in `lib/link-rules.js`. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording) are **not** standalone actions.

## Lab-only jevlike score

The frozen-encoder head (`jevlike_hf_chinese_roberta_r1.pt`) and worker route **`POST /v1/score`** support offline evaluation and training. Helpers: `lab/score-message.js`, `lib/score-message.js`.

| Field | Value |
|-------|--------|
| Score scale | `P(scam) × 100` (0–100) |
| `ARCHIVE_THRESHOLD` | `42` (from [scoring-rubric.json](scoring-rubric.json) unless overridden) |
| `SAFE_THRESHOLD` | `18` |
| `BLOCK_THRESHOLD` | `80` (lab archives at this level; lab never auto-blocks unsaved contacts from score alone) |
| `jevlikeMaxChars` | `2000` |

These thresholds do **not** drive live archive or block after the mask and LLM product path (2026-10-16).

Historical 366-row HK jevlike archive metrics describe the old scorer bar, not LLM precision. The eval defaults to `--mode off` (no LLM calls). To send requests, use `node scripts/review-eval.js --mode all --llm live` only with data safe to share: it uses the offline stub mask.

## Mask contract (live)

| Outcome | LLM called? | Archive from LLM? |
|---------|-------------|-------------------|
| `POST /v1/mask` success (including empty spans) | Yes, when LLM enabled | Per LLM rules above |
| Mask failure, truncated spans, invalid span | No | No (fail closed) |

Worker must load the PII mask head (`JEVLIKE_MASK_CKPT` / `models/jevlike_hf_pii_mask.pt`). Route returns 503 when the head is missing.
