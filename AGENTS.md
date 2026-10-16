# AGENTS.md — read this before changing anything

Local WhatsApp Web bot. Scores each 1:1 DM with a frozen-encoder **jevlike** choice model, archives risky
chats, blocks unsaved high-risk contacts, and can hand grey/high messages to an optional OpenAI-compatible LLM.
Human docs: [README.md](README.md) (setup, Pi, env vars), [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md)
(kept / improved / deferred / rejected + the action matrix), [SCORING_RUBRIC.md](SCORING_RUBRIC.md).

## Where things live

| Path | Role |
|---|---|
| `whatsapp-bot.js` | WhatsApp Web client: QR, orchestration, archive + graded block |
| `lib/decide-incoming.js` | primary action from jevlike score + link heuristics |
| `lib/jevlike-client.js`, `lib/score-message.js` | `{text}` → `{prob_scam}` over HTTP |
| `jevlike_serve.py` | persistent HF-encoder worker, `POST /v1/score` (start before the bot) |
| `lib/filters.js`, `lib/lid.js` | which messages count, `@lid` resolution |
| `lib/link-rules.js`, `lib/scam-intent.js` | link-only hard hits; solicit helpers for short links |
| `lib/malicious-hosts.js`, `data/malicious-hosts.json` | maintained known-malicious hosts; only path that auto-blocks unsaved contacts |
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

- **Primary users are elderly; false block cost is extreme.** Saved contacts are **never** auto-blocked.
  Unsaved contacts block **only** when the current message URL matches a host in `data/malicious-hosts.json`
  (exact or suffix). Lookalike hosts and soliciting short links **archive only** — they do not block.
  Models (context LLM, LLM review) do not auto-block. A jevlike score, including one ≥ `BLOCK_THRESHOLD` (80),
  only archives. Archive line `ARCHIVE_THRESHOLD` (42), safe line `SAFE_THRESHOLD` (18). Text such as 轉數快
  or 驗證碼 does not archive or block by itself.
- Scorer timeout / 5xx / invalid JSON → `unknown`, and `unknown` alone never archives (fail closed).
- **Every** outbound LLM call is masked by jevlike `POST /v1/mask` first. The bot writes `XXX` over those spans and never sends the raw text or the span list. If the PII head is missing or the mask call fails, the LLM call is skipped. The offline stub in `lib/mask-spans.js` stands in for the head so `npm test` does not load the encoder. Guided-mode explanations use the same mask. Archive/block receipts attach the chat-list name and phone locally; those fields are not added to the prompt.
- Context LLM (`CONTEXT_LLM_ENABLED`, default off) may archive from the latest inbound messages
  (`CONTEXT_LLM_MESSAGES`, default 10). The current message is always included. A model `block` answer
  is treated as archive only. Saved contacts stay unblockable. A score does not block. Mask failure or a
  bad model reply does not archive or block. Link-rule archives still skip it.
- Link-rule hard archives (lookalike, soliciting short link, malicious-host URL) skip the decision-changing LLM.
  Guided mode may still ask the chat API for a Cantonese explanation after the same mask, and that reply cannot archive, block, or hide the card.
- No keyword list suppresses a score. OTP, money, impersonation, and secrecy detectors do not archive
  or block. They are used only to recognise a soliciting short link, and as optional LLM-review triggers.
- No network lookup of phone numbers or URLs (no Scameter, no third-party registry).
- Thresholds and toggles change through `scoring-rubric.json` / env, never by editing constants in code.

## Commands

- `npm test` — offline: in-process stub, no live WhatsApp, no encoder download (JS half + Python half via
  `scripts/run-py-tests.js`). GitHub Actions (`.github/workflows/test.yml`) runs this on pull requests and on `main`.
- `python jevlike_serve.py` (or `npm run jevlike`) in terminal 1, then `npm start` in terminal 2.
- `npm run stub` with `JEVLIKE_BASE_URL=http://127.0.0.1:8766` — run the bot against fixed probabilities.

## Current state (update with the date when it changes) — 2026-10-16

- Hard archive hits are link rules: lookalike hosts, a soliciting short link, or a URL on the malicious-host list (same `obvious_scam` archive path). Lookalike and short-link hits **do not** auto-block. Only a malicious-host match on an unsaved contact blocks (`封鎖·惡意域名`). Extend the list in `data/malicious-hosts.json` (optional `MALICIOUS_HOSTS_PATH`). A bare host with no scheme counts. Allowlisted hosts such as `sf-express.com` are not lookalikes, and neither are `github.io`, `medium.com`, or `blogspot.com`. The brand has to start the label, on the registrable name or a subdomain, so `not-hangseng.com` and `not-hangseng.evil.com` do not match; `hsbc.evil.com` and `whatsapp-secure.evil.com` do. A hyphen stays inside the label, so `not-bit.ly` is not a short link. Fullwidth URLs are folded before the check. `youtu.be` is not a short link. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording) do not archive or block. Those lines follow the jevlike score, and the optional context LLM when it is on. A score alone does not block. A context-model `no_action` cannot release a window score that is already at the block line. Edited messages are scored again. A phone JID is kept when the paired id is `@lid`.
- A failed archive still messages the operator. The receipt says the archive did not happen. Block, rename, mute, archive, the receipt, and the guided card share one WhatsApp write queue.
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
  current message included) to the same OpenAI-compatible chat API. Model answers do not auto-block.
  Saved contacts stay unblockable. A score does not block. The single-message second pass uses the same mask.
- PII masking is a **separate** jevlike `AttentionHead` (`scripts/train_pii_mask.py` →
  `models/jevlike_hf_pii_mask.pt`, gitignored). It is initialised from the r1 head and trained with
  token-level labels, not the stock whole-message scam loss. The scam checkpoint is not overwritten.
  On a synthetic held-out split the char F1 was 1.0; that is not the 366-row HK set. Live `/v1/mask`
  returns only that head's spans. Lure words such as `驗證碼` are cleared from the mask so the later
  model still sees them. Without the head the route returns 503 and nothing is sent.
  `find_mask_spans` remains the training-label helper and the offline stub, not a live fallback.
  Its digit classes are ASCII `[0-9]`, the same characters JavaScript `\d` matches. Fullwidth phones
  and Chinese-numeral phones stay on the training-only extra gold, not on that shared stub.
- Unsaved contacts auto-block only on a current-message malicious-host match. Lookalike and short-link rules archive and still trigger operator receipts; they do not block. Score ≥ 80 archives and does not block. `sf-express.com` and the other allowlisted hosts are not lookalikes. A news quote of 封號 / USDT / 轉數快 / 驗證碼 / 順豐清關 does not hard-hit.
- Operator mode archives without blocking until the self-chat poll is answered (or `OPERATOR_MODE` is set).
  An obvious-scam heuristic on the current message is acted on before the scorer is called, so a slow score
  does not delay archive (or malicious-host block). `guided` forwards a suspicious DM to the operator, explains it only after
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
- `npm test` is the offline check (no WhatsApp, no encoder download). CI also runs `node scripts/review-eval.js --llm dry --mode triggers` on `fixtures/review-eval-smoke.json`. A live score is `GET http://127.0.0.1:8766/health` and `POST /v1/score` with `{"text":"..."}`. The worker does not read `.env`.
- Do not launch `npm start` for routine verification. WhatsApp Web needs an interactive QR login and can log the session out. Chrome for that path is `npx puppeteer browsers install chrome` (not part of `npm ci`).
