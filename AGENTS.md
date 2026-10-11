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
| `lib/heuristics.js`, `lib/link-rules.js`, `lib/scam-intent.js` | solicit-gated regex, lookalike hosts, self-OTP suppress |
| `lib/thread-context.js` | current body plus last `CONTEXT_TURNS` inbound bodies |
| `lib/mask-spans.js` | offline stand-in for the PII head; live `POST /v1/mask` does not use it |
| `POST /v1/mask` | jevlike PII head spans; the bot replaces them with `XXX` before any external LLM |
| `lib/context-llm.js` | optional review of the latest inbound messages (`CONTEXT_LLM_ENABLED`, default off) |
| `lib/llm-review.js` | optional second pass (OpenAI-compatible Chat Completions) + merge policy |
| `lib/block-policy.js`, `lib/wa-actions.js`, `lib/action-pacer.js` | graded block, paced WhatsApp writes |
| `lib/operator-mode.js`, `lib/review-queue.js` | self-chat choice: automatic, or ask before archive/block |
| `lib/review-prompt.js`, `lib/review-guide.js`, `lib/deliver-review.js` | local facts, masked Cantonese explanation, poll card |
| `lib/action-notice.js` | self-chat receipt after archive/block; name and phone stay on the machine |
| `stub-jevlike.js` | fixed probabilities for offline tests |

## Invariants — do not break

- Saved contacts are **never** auto-blocked. Unsaved contacts block only on an obvious-scam heuristic
  in the current message. That hit has to be a real solicit or an unsafe link (OTP handoff, impersonation
  plus solicit, 轉數快 with a payee, non-allowlisted 順豐 link, lookalike, or soliciting short link).
  A phrase-only trope does not hard-hit. A jevlike score, including one ≥ `BLOCK_THRESHOLD` (80),
  only archives. Archive line `ARCHIVE_THRESHOLD` (42), safe line `SAFE_THRESHOLD` (18).
- Scorer timeout / 5xx / invalid JSON → `unknown`, and `unknown` alone never archives (fail closed).
- **Every** outbound LLM call is masked by jevlike `POST /v1/mask` first. The bot writes `XXX` over those spans and never sends the raw text or the span list. If the PII head is missing or the mask call fails, the LLM call is skipped. The offline stub in `lib/mask-spans.js` stands in for the head so `npm test` does not load the encoder. Guided-mode explanations use the same mask. Archive/block receipts attach the chat-list name and phone locally; those fields are not added to the prompt.
- Context LLM (`CONTEXT_LLM_ENABLED`, default off) may archive from the latest inbound messages
  (`CONTEXT_LLM_MESSAGES`, default 10). The current message is always included.
  It does not block on its own: saved contacts stay unblockable, and an unsaved contact is blocked
  only by the existing heuristic on this message. A score does not block. Mask failure or a bad model reply
  does not archive. Heuristic hard archives still skip it.
- Heuristic / RAG / local-classifier hard archives skip the decision-changing LLM.
  Guided mode may still ask the chat API for a Cantonese explanation after the same mask, and that reply cannot archive, block, or hide the card.
- Suppress only a message that is itself an OTP delivery (`您的驗證碼是 …`, `don't share this code`)
  and does not also solicit. Words such as `防騙`, `小心`, `新聞`, or `警方提醒` do not suppress a score
  and do not clear a hard hit. A solicit still archives.
- No network lookup of phone numbers or URLs (no Scameter, no third-party registry).
- Thresholds and toggles change through `scoring-rubric.json` / env, never by editing constants in code.

## Commands

- `npm test` — offline: in-process stub, no live WhatsApp, no encoder download (JS half + Python half via
  `scripts/run-py-tests.js`). GitHub Actions (`.github/workflows/test.yml`) runs this on pull requests and on `main`.
- `python jevlike_serve.py` (or `npm run jevlike`) in terminal 1, then `npm start` in terminal 2.
- `npm run stub` with `JEVLIKE_BASE_URL=http://127.0.0.1:8766` — run the bot against fixed probabilities.

## Current state (update with the date when it changes) — 2026-10-11

- No warning-word table decides suppress or a hard hit. Phrase-only tropes (封號, USDT wallet send, 轉數快 without a payee, 驗證碼過期 without an OTP handoff) are not hard hits, so a news quote of them does not block. The scorer decides whether that quote archives. Lookalike and short-link hits still block an unsaved contact, including when the text says 這不是詐騙. An official host such as `sf-express.com` does not trip `sf_customs_link`. A later message whose own score is already at the archive line still archives.
- A mask response that is truncated, short a row, or has a non-integer span is a failed mask. The LLM call is skipped. Empty span lists (no PII) are still success.

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
  Its digit classes are ASCII `[0-9]`, the same characters JavaScript `\d` matches. Fullwidth phones
  and Chinese-numeral phones stay on the training-only extra gold, not on that shared stub.
- Unsaved contacts are blocked only by a current-message obvious-scam heuristic. Score ≥ 80 archives and does not block. `otp_expiry` needs an OTP handoff ask. `fps_urgent_transfer` needs a payee (`到此帳戶`, `俾我`, `我的戶口`). `sf_customs_link` ignores an allowlisted official host such as `sf-express.com`. A news quote of 封號 / USDT / 轉數快 / 驗證碼過期 does not hard-hit by itself. Lookalike and short-link hits still block an unsaved contact, including when the text says 這不是詐騙. A later message whose own score is already at the archive line still archives.
- Operator mode archives without blocking until the self-chat poll is answered (or `OPERATOR_MODE` is set).
  An obvious-scam heuristic on the current message is acted on before the scorer is called, so a slow score
  does not delay that block. `guided` forwards a suspicious DM to the operator, explains it only after
  `/v1/mask`, and waits for 封鎖並封存 / 只封存 / 留低. A failed mask skips the explanation and still shows
  the poll. The explanation model cannot take that action. An explicit 封鎖並封存 is the only way a saved
  contact is blocked. After every completed archive or block (automatic, or a guided 封鎖並封存 / 只封存),
  the bot messages the operator's own chat with the chat-list name, the phone, and the local reason. The
  optional Cantonese paragraph on an automatic receipt uses the masked transcript only; the name and phone
  are attached locally and are not sent to the chat API. A failed mask still sends the receipt. Choosing 留低 does not.

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
