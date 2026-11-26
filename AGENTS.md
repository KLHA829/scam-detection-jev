# AGENTS.md — read this before changing anything

Local WhatsApp Web bot. **Masks PII locally**, sends masked text to a **required OpenAI-compatible LLM** for
archive/ignore on each 1:1 DM, archives curated blocklist matches without the LLM, and **blocks unsaved contacts only**
on the maintained malicious-host list. Human docs: [README.md](README.md), [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md),
[SCORING_RUBRIC.md](SCORING_RUBRIC.md) (decision rubric; jevlike score is lab-only).

## Pull requests

- Each PR solves exactly one problem. Do not bundle several problems into one PR, and do not split one problem across several PRs.

## Where things live

| Path | Role |
|---|---|
| `whatsapp-bot.js` | WhatsApp Web client: QR, orchestration, archive + graded block (transport-agnostic) |
| `lib/wa-transport/` | `WaTransport` boundary (`whatsmeow` Go sidecar HTTP/SSE default adapter, `wwebjs` legacy adapter) |
| `wa-bridge/` | pure-Go `whatsmeow` + `modernc.org/sqlite` local loopback HTTP/SSE sidecar (no Chromium/CGO) |
| `lib/decide-incoming.js` | curated URL and email-domain archive only; else ignore until LLM merge |
| `lib/handle-incoming.js` | inbound orchestration: heuristic fast path → mask → LLM |
| `lib/jevlike-client.js` | HTTP client (`createMaskClient`; `/v1/mask` live; `/v1/score` lab-only) |
| `lib/score-message.js` | rubric load + threshold helpers (lab eval; not inbound archive) |
| `lab/score-message.js` | lab-only `scoreMessage` via `/v1/score` |
| `jevlike_serve.py` | persistent worker: **`POST /v1/mask`** required; `/v1/score` optional for eval |
| `lib/filters.js`, `lib/lid.js` | which messages count, `@lid` resolution |
| `lib/link-rules.js`, `lib/scam-intent.js` | link and solicitation signals for review; curated blocklist exception |
| `lib/malicious-hosts.js`, `data/malicious-hosts.json` | maintained known-malicious hosts; only path that auto-blocks unsaved contacts |
| `lib/thread-context.js` | current body plus last `CONTEXT_TURNS` inbound bodies; at most 1000 chats by default |
| `test/support/mask-spans-stub.js` | offline regex stand-in for stub worker; live inbound must not require it |
| `lib/pii-xxx.js` | apply mask spans to text (`XXX`); not a live mask fallback |
| `POST /v1/mask` | jevlike PII head spans; the bot replaces them with `XXX` before any external LLM |
| `lib/context-llm.js` | review of the latest messages of a chat, inbound plus the user's own marked `user:` (`CONTEXT_LLM_ENABLED`, default **on**); at most 1000 chats by default |
| `lib/llm-review.js` | **primary** judgment (OpenAI-compatible Chat Completions) after mask |
| `lib/block-policy.js`, `lib/wa-actions.js`, `lib/action-pacer.js` | graded block, paced WhatsApp writes |
| `lib/operator-mode.js`, `lib/review-queue.js` | self-chat choice: automatic, or ask before archive/block |
| `lib/review-prompt.js`, `lib/review-guide.js`, `lib/deliver-review.js` | local facts, masked Cantonese explanation, poll card |
| `lib/action-notice.js` | self-chat receipt after archive/block; name and phone stay on the machine |
| `stub-jevlike.js` | fixed probabilities for offline tests |

## Invariants — do not break

- **Primary users are elderly; false block cost is extreme.** Saved contacts are **never** auto-archived or auto-blocked. Any suspicious result for a saved contact goes to the operator's self-chat review card, even in automatic mode or before setup. Archive reasons below are recommendations until this operator policy is applied.
  Unsaved contacts block **only** when the current message URL matches a host in `data/malicious-hosts.json`
  (exact or suffix). Blocklisted email addresses recommend archive without blocking. Lookalike hosts
  and soliciting short links go to AI review and never archive or block by themselves.
  Models (context LLM, primary LLM) do not auto-block. **No jevlike score** drives live archive/block.
  Text such as 轉數快 or 驗證碼 does not archive or block by itself.
- **Every** outbound LLM call is masked by jevlike `POST /v1/mask` first. The bot writes `XXX` over those spans and never sends the raw text or the span list. The one exception is a brand's own domain on the link-rule allowlist (`officialHosts`): it is not personal data, so it stays readable while the rest of its link stays masked, and the system prompt says it is official. Lookalike and unknown domains stay masked. If the PII head is missing or the mask call fails, the LLM call is skipped (**fail closed**: no archive). The offline regex stub (`test/support/mask-spans-stub.js`) feeds `stub-jevlike.js` only so `npm test` does not load the encoder. Guided-mode explanations use the same mask. Archive/block receipts attach the chat-list name and phone locally; those fields are not added to the prompt.
- Primary LLM (`LLM_REVIEW_ENABLED`, default **on**) runs on every DM outside the blocklist fast path: mask → `reviewRedactedMessage` → archive `llm_review_scam` only when `confidence >= LLM_REVIEW_MIN_CONFIDENCE` (default **0.7**); lower or missing confidence → ignore. LLM failure or `unknown` → ignore.
- After a successful primary or context LLM review recommends archive, the per-chat cooldown (`LLM_REVIEW_COOLDOWN_MS`, default 10 min / 600000) skips further mask+LLM. It starts on a deferred recommendation or after a successful automatic archive. If cooldown cannot be saved to `llm-review-cooldown.json` (`LLM_REVIEW_COOLDOWN_PATH` optional), it remains active in memory but does not survive restart.
- Context LLM (`CONTEXT_LLM_ENABLED`, default **on**) replaces the single-message path with a masked transcript of the latest messages (`CONTEXT_LLM_MESSAGES`, default 10): inbound bodies plus the user's own 1:1 messages, masked the same way and marked `user:`. `LLM_REVIEW_ENABLED=false` disables both review paths; blocklist archives still work. Set `CONTEXT_LLM_ENABLED=0` or `false` for single-message primary LLM only. Archive/block answers use the same confidence gate. On the first message from an unsaved number with no earlier turn in the chat, an archive/block answer acts only when the model also sets `strong: true` (asks for a code, password or login; impersonates a bank, payment service, police, government office or WhatsApp; or links to a fake login or payment page); otherwise the chat is left in place and the next message is reviewed again with this one as context. A model `block` answer is archive only. When the review does not archive, `pitch: true` (unsolicited investment, trading or health-product pitch) only renames an unsaved sender to `（可疑推銷）`; it never archives, blocks, mutes or renames a saved contact. A name the bot wrote for that number (`BOT_CONTACT_NAMES_PATH`, default `./bot-contact-names.json`) does not count as a saved contact; the same text saved by the user does. The label is not written if the message was edited during pacing. A later confident `no_action` review with `pitch: false` deletes that label again, only while the live name is still the one the bot wrote. Saved contacts stay unblockable. Mask failure or a bad model reply does not archive or block. Blocklist archives still skip it.
- Only a curated URL or email-domain match takes the direct archive path before block policy.
  Warning-only scam reports go to masked LLM review regardless of saved status or forwarding metadata, before all hard-link rules. One hard-hit URL occurrence is allowed alongside genuine-site references; direct solicitations, repeated flagged URLs and additional flagged links still hard-hit.
  Guided mode may still ask the chat API for a Cantonese explanation after the same mask, and that reply cannot archive, block, or hide the card.
- OTP, money, impersonation, and secrecy detectors do not archive or block. They are used only to recognise a soliciting short link.
- No network lookup of phone numbers or URLs (no Scameter, no third-party registry).
- Thresholds and toggles change through `scoring-rubric.json` / env, never by editing constants in code.

## Commands

- `npm test` — offline: in-process stub, no live WhatsApp, no encoder download (JS half + Python half via
  `scripts/run-py-tests.js`). GitHub Actions (`.github/workflows/test.yml`) runs this on pull requests and on `main`.
- `npm run lint` and `ruff check .` — JavaScript ESLint and Python Ruff checks.
- `npm run typecheck` — TypeScript checks production JavaScript without emitting files.
- `npm run test:e2e` — real local HTTP mask/LLM mocks drive the inbound path; no WhatsApp login.
- `node scripts/legit-fpr.js` — false block / false archive rate on ~300 legit messages (`fixtures/legit-messages.json`) through the real handler, model answering not_scam. `lib/legit-fpr.test.js` (in `npm test`) fails when that list differs from `fixtures/legit-fpr-baseline.json`; rerun with `--update-baseline` only for an intended change.
- `npm run wa-bridge:build` — compile pure-Go `wa-bridge/` (`CGO_ENABLED=0`; supports `--goos` / `--goarch` for Linux cross-builds).
- `npm run test:e2e:boot` — best-effort boot through Chromium launch and QR emission; never scan the QR.
- `npm run test:e2e:boot:whatsmeow` — Chromium-free best-effort boot compiling `wa-bridge` to a temp dir and waiting for QR emission; never scan the QR.
- `python jevlike_serve.py` (or `npm run jevlike`) in terminal 1 — **PII mask head required**; then `npm start` in terminal 2 with `LLM_REVIEW_*` set.
- `npm run stub` with `JEVLIKE_BASE_URL=http://127.0.0.1:8766` — stub worker for offline tests (mask + optional fixed scores).

## Current state — 2026-11-26

- Default transport is `whatsmeow` (`WA_TRANSPORT=whatsmeow`, `WA_BRIDGE_AUTO_START` on when `WA_BRIDGE_URL`/`WA_BRIDGE_TOKEN` are unset); set `WA_TRANSPORT=wwebjs` for legacy Chromium.
- `CONTEXT_LLM_ENABLED` (default **on**) reviews masked 1:1 transcripts (inbound + `user:` messages), unmasks allowlisted `officialHosts` domains in prompts, requires `strong: true` on first unsaved message, and labels unsolicited pitches `（可疑推銷）` via `BOT_CONTACT_NAMES_PATH` (removed on confident `no_action` with `pitch: false`).
- Chats restored from archive (`USER_RESTORED_CHATS_PATH`), whether seen live or reconciled from a whatsmeow full sync, and `@lid` / unknown-saved-status contacts go to the self-chat review card instead of auto-archive/block.
- `/v1/mask` chunks messages longer than `context_tokens` (96) with overlapping windows; `jevlike_serve.py` does not read `.env` (export `JEVLIKE_MASK_CKPT`).
- See [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) for historical state and detailed rationale.

## Landmines

- Do **not** run `npm audit fix` — it downgrades puppeteer and breaks the bot (see README).
- Do not commit `.env`, `.wwebjs_auth/`, `wa-bridge.db*`, `*.pt`, or HF encoder weights.
- Default `whatsmeow` uses `npm run wa-bridge:build` (no Chrome); Chromium is only needed when `WA_TRANSPORT=wwebjs` (`npx puppeteer browsers install chrome`).
- This bot is a personal filter on your own account, not a service. WhatsApp Web automation can log the
  session out; keep `wa-bridge.db` (or `.wwebjs_auth/` for `wwebjs`).

**Gardener:** When you fix a behavior bug or doc drift, encode the correction in tests, CI, or `.cursor/skills/verify-scam-bot/` (feature map + `bin/drive-*`) — not only in this file. Follow the Maintenance checklist in that skill.

**Full Autopilot (無人盯內環):** Agents follow [`.cursor/skills/full-autopilot/SKILL.md`](.cursor/skills/full-autopilot/SKILL.md) (goal → verifiable units → self-prove → open PR, never merge unless asked). Self-proof uses [verify-scam-bot](.cursor/skills/verify-scam-bot/SKILL.md) (`bin/doctor`, `bin/drive-*`, then `npm test`). PR #51 locks in `lib/agent-trust.test.js`: mask-before-LLM on inbound, `createMaskClient` / no live `lab/score-message`, verify smoke mask-primary (`drive-mask-before-llm`), `verify-scam-detection-jev` redirect only. Do not reopen settled product decisions in the invariants section above.

## Invariant enforcement (tests / CI)

| Invariant | Enforced by |
|---|---|
| Mask before primary LLM on inbound | `lib/agent-trust.test.js` (maskMessages before `reviewRedactedMessage`; no `lab/score-message` on live path) |
| Verify skill smoke is mask-primary | `lib/agent-trust.test.js` (`verify-scam-bot` + `verify-scam-detection-jev` redirect/shims) |
| No live jevlike score on inbound | `lib/agent-trust.test.js` (no `scoreMessage` in `handle-incoming`); `lab/score-message.js` quarantine |
| Live path uses `maskClient` / `createMaskClient` | `lib/agent-trust.test.js` (no `scoreClient` in `handle-incoming`, `whatsapp-bot.js`) |
| Live bot boots and handles DMs without `scoring-rubric.json` | `lib/agent-trust.test.js` (no `loadRubric` / `RUBRIC_PATH` in `handle-incoming`, `whatsapp-bot.js`) |
| No model / lookalike / score auto-block | `lib/agents-invariants.test.js`, `lib/block-policy.test.js` |
| Malicious-host match not starved by lookalike order | `lib/link-rules.js` order; `lib/link-rules.test.js` dual-hit case |
| Mask fail-closed (no archive on mask fail) | `lib/agents-invariants.test.js` |
| Production must not import offline mask stub | `lib/agent-trust.test.js` |
| `data/corpus/` not imported live | `lib/agent-trust.test.js` |
| README must not regress to score-primary docs | `lib/agent-trust.test.js` |
| Empty `hosts:[]` reload does not silently wipe list | `lib/malicious-hosts.test.js`; set `MALICIOUS_HOSTS_ALLOW_EMPTY=1` to clear |
| Non-string `hosts` entry fails the reload and keeps the previous list | `lib/malicious-hosts.test.js` |
| Test-infra-only malicious hosts warn at load | `lib/malicious-hosts.js` (`warnIfTestInfraOnly`) |

## Cursor Cloud specific instructions

- Node 22 and Python 3.12 are on the default image. `python3-venv` is not, so a venv needs that package first. Scorer dependencies live in `.venv` (gitignored). Start the worker with `.venv/bin/python jevlike_serve.py`. `npm test` uses system `python3` and does not import torch.
- The r1 head is not in git. `scripts/download_jevlike_ckpt.sh` writes `models/jevlike_hf_chinese_roberta_r1.pt`. The public release URL 404s on this private repo; the script falls back to `gh`. The frozen encoder `hfl/chinese-roberta-wwm-ext` caches under `~/.cache/huggingface`.
- `npm test` is the offline check (no WhatsApp, no encoder download). CI also runs `node scripts/review-eval.js --llm dry --mode all` on `fixtures/review-eval-smoke.json`. Live mask: `POST /v1/mask` with `{"messages":["..."]}`. The worker does not read `.env`.
- Do not launch `npm start` for routine verification. WhatsApp Web needs an interactive QR login and can log the session out. Chrome (`npx puppeteer browsers install chrome`, not part of `npm ci`) is only needed for legacy `WA_TRANSPORT=wwebjs`.
