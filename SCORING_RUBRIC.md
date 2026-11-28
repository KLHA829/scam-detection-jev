# Decision rubric (reference)

Live 1:1 DMs use link heuristics, **`POST /v1/mask`**, and an OpenAI-compatible LLM (`lib/llm-review.js` or `lib/context-llm.js`). Setup and env wiring: [README.md](README.md). Rationale: [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

## Live path summary

| Stage | Trigger | Archive reason | Block |
|-------|---------|----------------|-------|
| Known malicious URL | Blocklisted URL on **current** message; bypasses cooldown and appends device-checked note (no raw host) to LLM prompt | Mask → AI (`context_llm` or `llm_review_scam`) | Unsaved + malicious-host match + AI confirms scam |
| Blocklisted email domain | Email address with a listed host on **current** message; bypasses cooldown and appends device-checked note (no raw host) to LLM prompt | Mask → AI (`context_llm` or `llm_review_scam`) | Never |
| Link lookalike rule | Brand lookalike host (`lookalike_domain`). Short links and phrase tropes have no separate heuristic rule and go straight to masked AI review. | Mask → AI; no rule-only archive | Never from the rule |
| Context LLM (default) | `CONTEXT_LLM_ENABLED` on (default when unset) | `context_llm` when model says `archive` or `block` with sufficient confidence; otherwise `pitch: true` only renames an unsaved sender to `（可疑推銷）` | Never from LLM alone |
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

| Contact | Malicious-host URL on current message | Blocklisted email | Lookalike host |
|---------|--------------------------------------|-------------------|-------------------------|
| Unsaved | May **block** (`封鎖·惡意域名`) after AI confirms scam | Archive only after AI confirms scam | AI review only; never auto-block |
| Saved | Masked AI review; operator alert only if AI confirms scam | Masked AI review; operator alert only if AI confirms scam | Masked AI review; operator alert only if AI confirms scam |

Saved contacts also get an alert rather than an automatic archive when flagged by either model, regardless of operator mode.

All messages — including anti-scam warnings quoting a blocklisted URL or lookalike — go through **mask → LLM** (no linguistic warning-only regexes). When a message matches `data/malicious-hosts.json`, the bot appends a device-checked note (never the raw hostname) so the LLM classifies lures as scam while leaving anti-scam warnings as `no_action`/`not_scam`. Mask failure or disabled LLM fails closed (no archive or block).

List file: [`data/malicious-hosts.json`](data/malicious-hosts.json). Optional path override: `MALICIOUS_HOSTS_PATH`. Empty `hosts:[]` keeps the previous list unless `MALICIOUS_HOSTS_ALLOW_EMPTY=1`.

### Link rules (not phrase tropes)

Implemented in `lib/link-rules.js`. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording) are **not** standalone actions.

## Eval harness

`node scripts/review-eval.js --mode all --llm dry` validates request formatting using the offline stub mask; `--llm live` posts masked text to your configured LLM API and should only be used with data safe to share.

## Mask contract (live)

| Outcome | LLM called? | Archive from LLM? |
|---------|-------------|-------------------|
| `POST /v1/mask` success (including empty spans) | Yes, when LLM enabled | Per LLM rules above |
| Mask failure, truncated spans, invalid span | No | No (fail closed) |

Worker must load the PII mask head (`JEVLIKE_MASK_CKPT` / `models/jevlike_hf_pii_mask.pt`) at startup.
