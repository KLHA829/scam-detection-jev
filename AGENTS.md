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
| `lib/mask-spans.js` | offline stand-in for the PII head; live `POST /v1/mask` does not use it |
| `POST /v1/mask` | jevlike PII head spans; the bot replaces them with `XXX` before any external LLM |
| `lib/context-llm.js` | optional review of the latest inbound messages (`CONTEXT_LLM_ENABLED`, default off) |
| `lib/llm-review.js` | optional second pass (OpenAI-compatible Chat Completions) + merge policy |
| `lib/block-policy.js`, `lib/wa-actions.js`, `lib/action-pacer.js` | graded block, paced WhatsApp writes |
| `lib/operator-mode.js`, `lib/review-queue.js` | self-chat choice: automatic, or ask before archive/block |
| `lib/review-prompt.js`, `lib/review-guide.js`, `lib/deliver-review.js` | local facts, masked Cantonese explanation, poll card |
| `stub-jevlike.js` | fixed probabilities for offline tests |

## Invariants — do not break

- Saved contacts are **never** auto-blocked. Unsaved contacts block only on an obvious-scam heuristic
  in the current message. A pure warning (`小心` / `防騙`, and no OTP ask, money ask, or impersonation plus
  secrecy) beats that heuristic and is left alone. A jevlike score, including one ≥ `BLOCK_THRESHOLD` (80),
  only archives. Archive line `ARCHIVE_THRESHOLD` (42), safe line `SAFE_THRESHOLD` (18).
- Scorer timeout / 5xx / invalid JSON → `unknown`, and `unknown` alone never archives (fail closed).
- **Every** outbound LLM call is masked by jevlike `POST /v1/mask` first. The bot writes `XXX` over those spans and never sends the raw text or the span list. If the PII head is missing or the mask call fails, the LLM call is skipped. The offline stub in `lib/mask-spans.js` stands in for the head so `npm test` does not load the encoder. Guided-mode explanations use the same mask.
- Context LLM (`CONTEXT_LLM_ENABLED`, default off) may archive from the latest inbound messages
  (`CONTEXT_LLM_MESSAGES`, default 10). The current message is always included.
  It does not block on its own: saved contacts stay unblockable, and an unsaved contact is blocked
  only by the existing heuristic on this message. A score does not block. Mask failure or a bad model reply
  does not archive. Heuristic hard archives still skip it.
- Heuristic / RAG / local-classifier hard archives skip the decision-changing LLM.
  Guided mode may still ask the chat API for a Cantonese explanation after the same mask, and that reply cannot archive, block, or hide the card.
- Suppress only when copy merely warns (`防騙`, `小心`). On the current message that also beats a hard
  regex. It still archives if it also solicits OTP, a money transfer, or impersonation + secrecy.
- No network lookup of phone numbers or URLs (no Scameter, no third-party registry).
- Thresholds and toggles change through `scoring-rubric.json` / env, never by editing constants in code.

## Commands

- `npm test` — offline: in-process stub, no live WhatsApp, no encoder download (JS half + Python half via
  `scripts/run-py-tests.js`).
- `python jevlike_serve.py` (or `npm run jevlike`) in terminal 1, then `npm start` in terminal 2.
- `npm run stub` with `JEVLIKE_BASE_URL=http://127.0.0.1:8766` — run the bot against fixed probabilities.

## Current state (update with the date when it changes) — 2026-10-10

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
  to hide, replaces those spans with `XXX`, then sends the latest inbound messages (default 10,
  current message included) to the same OpenAI-compatible chat API. A context-model `block` does not
  override the graded block gate. The single-message second pass uses the same mask.
- PII masking is a **separate** jevlike `AttentionHead` (`scripts/train_pii_mask.py` →
  `models/jevlike_hf_pii_mask.pt`, gitignored). It is initialised from the r1 head and trained with
  token-level labels, not the stock whole-message scam loss. The scam checkpoint is not overwritten.
  On a synthetic held-out split the char F1 was 1.0; that is not the 366-row HK set. Live `/v1/mask`
  returns only that head's spans. Lure words such as `驗證碼` are cleared from the mask so the later
  model still sees them. Without the head the route returns 503 and nothing is sent.
  `find_mask_spans` remains the training-label helper and the offline stub, not a live fallback.
- Unsaved contacts are blocked only by a current-message obvious-scam heuristic. Score ≥ 80 archives and does not block. `otp_expiry` needs an OTP ask or a link. `sf_customs_link` ignores an allowlisted official host such as `sf-express.com`. A current message with `小心` or `防騙` and no solicit is left alone even when a hard regex matches.
- Operator mode archives without blocking until the self-chat poll is answered (or `OPERATOR_MODE` is set).
  An obvious-scam heuristic on the current message is acted on before the scorer is called, so a slow score
  does not delay that block. `guided` forwards a suspicious DM to the operator, explains it only after
  `/v1/mask`, and waits for 封鎖並封存 / 只封存 / 留低. A failed mask skips the explanation and still shows
  the poll. The explanation model cannot take that action. An explicit 封鎖並封存 is the only way a saved
  contact is blocked.

## Landmines

- Do **not** run `npm audit fix` — it downgrades puppeteer and breaks the bot (see README).
- Do not commit `.env`, `.wwebjs_auth/`, `*.pt`, or HF encoder weights.
- Chromium is not installed by `npm install`: run `npx puppeteer browsers install chrome` before `npm start`.
- This bot is a personal filter on your own account, not a service. WhatsApp Web automation can log the
  session out; keep `.wwebjs_auth/`.

## Cursor Cloud specific instructions

- Node 22 and Python 3.12 are on the default image. `python3-venv` is not, so a venv needs that package first. Scorer dependencies live in `.venv` (gitignored). Start the worker with `.venv/bin/python jevlike_serve.py`. `npm test` uses system `python3` and does not import torch.
- The r1 head is not in git. `scripts/download_jevlike_ckpt.sh` writes `models/jevlike_hf_chinese_roberta_r1.pt`. The public release URL 404s on this private repo; the script falls back to `gh`. The frozen encoder `hfl/chinese-roberta-wwm-ext` caches under `~/.cache/huggingface`.
- `npm test` is the offline check (no WhatsApp, no encoder download). A live score is `GET http://127.0.0.1:8766/health` and `POST /v1/score` with `{"text":"..."}`. The worker does not read `.env`.
- Do not launch `npm start` for routine verification. WhatsApp Web needs an interactive QR login and can log the session out. Chrome for that path is `npx puppeteer browsers install chrome` (not part of `npm ci`).
