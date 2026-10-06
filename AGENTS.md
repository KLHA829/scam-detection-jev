# AGENTS.md — read this before changing anything

Local WhatsApp Web bot. Scores each 1:1 DM with a frozen-encoder **jevlike** choice model, archives risky
chats, blocks unsaved high-risk contacts, and can hand grey/high messages to an optional OpenAI-compatible LLM.
Human docs: [README.md](README.md) (setup, Pi, env vars), [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md)
(kept / improved / deferred / rejected + the action matrix), [SCORING_RUBRIC.md](SCORING_RUBRIC.md).

## Where things live

| Path | Role |
|---|---|
| `whatsapp-bot.js` | WhatsApp Web client: QR, orchestration, archive + graded block |
| `lib/decide-incoming.js` | primary action from score + heuristic + rag + local classifier |
| `lib/scorer.js` → `lib/jevlike-client.js` | `{text}` → `{prob_scam}` over HTTP |
| `jevlike_serve.py` | persistent HF-encoder worker, `POST /v1/score` (start before the bot) |
| `lib/filters.js`, `lib/lid.js` | which messages count, `@lid` resolution |
| `lib/heuristics.js`, `lib/link-rules.js`, `lib/scam-intent.js` | tight regex, lookalike hosts, intent-gated suppress |
| `lib/thread-context.js` | current body plus last `CONTEXT_TURNS` inbound bodies |
| `lib/redact.js` | rule-based PII redaction — the only thing between raw text and any external API |
| `lib/mask-spans.js`, `POST /v1/mask` | identifier spans; the bot replaces them with `XXX` before the context LLM |
| `lib/context-llm.js` | optional first-10-message review (`CONTEXT_LLM_ENABLED`, default off) |
| `lib/llm-review.js` | optional second pass (OpenAI-compatible Chat Completions) + merge policy |
| `lib/block-policy.js`, `lib/wa-actions.js`, `lib/action-pacer.js` | graded block, paced WhatsApp writes |
| `stub-jevlike.js` | fixed probabilities for offline tests |

## Invariants — do not break

- Saved contacts are **never** auto-blocked. Unsaved contacts block only on an obvious-scam heuristic or score
  ≥ `BLOCK_THRESHOLD` (80). Archive line `ARCHIVE_THRESHOLD` (42), safe line `SAFE_THRESHOLD` (18).
- Scorer timeout / 5xx / invalid JSON → `unknown`, and `unknown` alone never archives (fail closed).
- **Every** outbound LLM call goes through `redactPii` first; the local placeholder mapping is never sent.
  The context-LLM path also applies `/v1/mask` spans as `XXX` before that redaction.
- Context LLM (`CONTEXT_LLM_ENABLED`, default off) may archive from the first 10 inbound messages.
  It does not block on its own: saved contacts stay unblockable, and an unsaved contact is blocked
  only by the existing heuristic or score ≥ `BLOCK_THRESHOLD`. Mask failure or a bad model reply
  does not archive. Heuristic hard archives still skip it.
- Heuristic / RAG / local-classifier hard archives skip the LLM.
- Suppress only when copy merely warns (`防騙`, `小心`); it still archives if it also solicits OTP, a money
  transfer, or impersonation + secrecy.
- No network lookup of phone numbers or URLs (no Scameter, no third-party registry).
- Thresholds and toggles change through `scoring-rubric.json` / env, never by editing constants in code.

## Commands

- `npm test` — offline: in-process stub, no live WhatsApp, no encoder download (JS half + Python half via
  `scripts/run-py-tests.js`).
- `python jevlike_serve.py` (or `npm run jevlike`) in terminal 1, then `npm start` in terminal 2.
- `npm run stub` with `JEVLIKE_BASE_URL=http://127.0.0.1:8766` — run the bot against fixed probabilities.

## Current state (update with the date when it changes) — 2026-10-06

- **Deployed head is `r1`**: `models/jevlike_hf_chinese_roberta_r1.pt`, published on release tag
  [`jevlike-hf-r1`](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1). On a 366-row real
  HK set (179 scam / 187 innocent) it wrongly flags 18/187 innocents (9.6%) at the archive line and 10/187
  (5.3%) at the block line, versus 43/187 (23.0%) and 38/187 (20.3%) for the older `hn800` head (tag
  `jevlike-hf-hn800`, still on disk as `hf_chinese_roberta_hn800.pt`). Recall drops 0.575 -> 0.508; this deploy
  is precision-first, so that trade is intentional.
- `jevlike_serve.py` does **not** read `.env` (no dotenv). The worker takes `JEVLIKE_CKPT` from its own
  environment, so whatever starts it must export it — a `.env` edit alone does not switch the head.
- The LLM second pass is **off by default and has never been measured on a labelled real corpus** — the repo's
  tests are stub unit tests, so any claim about its end-to-end precision is unverified. `scripts/review-eval.js`
  runs the real pipeline offline (`--llm dry` needs no key) to measure it.
- High-recall heads (`r4`, `r5` in `jevlike-lab/runs/`) are **wrong for this product**: at score 42 they wrongly
  flag 34-41% of innocents.
- Optional `CONTEXT_LLM_ENABLED` (default off) asks the local worker `POST /v1/mask` which characters
  to hide, replaces those spans with `XXX`, runs `redactPii` again, then sends the first 10 inbound
  messages to the same OpenAI-compatible chat API. The r1 head is not the masker: it has no PII
  labels, and its attention sits on lure words the later model still needs. A model `block` does not
  override the graded block gate.
- `lib/redact.js` name masking is surname-gated: a run after `我係`/`本人` is masked only when it starts with a
  listed HK surname or `阿`, so `我係收數公司` and `如非本人操作` are no longer corrupted before the LLM sees them.
  Compound surnames (e.g. `我係歐陽文`) and role tails after a single-char surname (e.g. `我係張經理`) are handled in `NAME_TOKEN`.

## Landmines

- Do **not** run `npm audit fix` — it downgrades puppeteer and breaks the bot (see README).
- Do not commit `.env`, `.wwebjs_auth/`, `*.pt`, or HF encoder weights.
- Chromium is not installed by `npm install`: run `npx puppeteer browsers install chrome` before `npm start`.
- This bot is a personal filter on your own account, not a service. WhatsApp Web automation can log the
  session out; keep `.wwebjs_auth/`.
