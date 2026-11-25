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
| `lib/wa-transport/` | `WaTransport` boundary (`wwebjs` default adapter, `whatsmeow` Go sidecar HTTP/SSE adapter) |
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

## Current state (update with the date when it changes) — 2026-11-25

- The context, primary and guided-explanation prompts name the allowlisted (official) domains in the masked text, and those domains are not masked, so the model no longer sees `https://payme.XXX` for a real PayMe link and calls it a fake payment page. Lookalike and unknown domains stay masked and add nothing to the prompt; unmasking lookalikes made the model archive warnings that quote a fake domain (2026-11-25).
- The bot supports Chromium-free Linux/macOS/Windows operation via `WaTransport` (`lib/wa-transport/`) and the pure-Go `wa-bridge/` (`whatsmeow` + `modernc.org/sqlite`) sidecar (`WA_TRANSPORT=whatsmeow`); `Dockerfile` uses a multi-stage Go + Node 22 build defaulting to `whatsmeow` with `/data` state paths, `npm run wa-bridge:build` builds the sidecar, and `npm run test:e2e:boot:whatsmeow` verifies Chromium-free QR emission in CI while `resolveTransportName` keeps `wwebjs` as default until live QR validation completes (2026-11-24).
- A 1:1 chat the user moves out of the archive (`chat_archived` with `prev=true`, `curr=false`) is recorded in `USER_RESTORED_CHATS_PATH` (default `./user-restored-chats.json`). Model verdicts on that chat then go to the self-chat review card like a saved contact, after any cooldown or restart; a curated malicious-host match from an unsaved sender still archives and blocks, while a saved or unknown-status sender gets the review card (2026-11-24).
- Saved status of a `@lid` sender is read from its phone-number contact (the address book is keyed by phone number), unless the LID record already says saved. When it cannot be read, or WhatsApp gives no saved flag, the status is unknown: like a saved contact it only gets the review card and is never auto-archived, blocked or labelled (2026-11-24).
- `/v1/mask` scores a message longer than the PII head's trained context (`context_tokens`, 96 by default) in overlapping windows of that size and masks a character when any window flags it, so long messages reach AI review instead of failing as truncated. Trailing characters the tokenizer emits no token for (spaces, an emoji variation selector) are not truncation. A tokenizer that still drops text fails the mask (2026-11-24).
- A `（可疑推銷）` label the bot wrote is removed when a later review of the chat is a confident `no_action` with `pitch: false`; a contact the user saved or renamed is left alone (2026-11-23).
- A first message from an unsaved number archives only on strong evidence (`strong: true`); a weak scam verdict waits for the sender's next message, so a clinic or shop that writes first after the user gave a number in person is not archived (2026-11-23).
- The context review transcript includes the user's own messages in 1:1 chats (recorded from `message_create`, edits replaced in place), masked like inbound and marked `user:`; the prompt treats a payment, deposit or details request that completes a purchase, booking or service the user asked for as ordinary chat. Inbound-only transcripts are unchanged (2026-11-23).
- Context review returns a separate `pitch` verdict for unsolicited investment, trading or health-product pitches; when it does not archive, an unsaved sender is renamed `（可疑推銷）` and the chat stays in place. Names the bot wrote are tracked per number, so a labelled sender that later asks for a code or money still archives, while a contact the user saved under the same text stays protected (2026-11-22).
- The context LLM prompt (default path) lists money already sent to the user, bank alerts that only report a transaction or login on the user's own account, and one-time codes the user is told not to share as ordinary chat (no_action) (2026-11-22).
- Short-link money hits still require the existing money-transfer ask: a link word alone no longer counts; without the unchanged urgency/account trigger, the link must be the payment destination in the same clause. This narrows the heuristic; masked AI still decides whether to archive (2026-11-22).
- Warning-only scam reports bypass all hard-link rules for saved and unsaved senders, forwarded or not; quoted/reported/negated lures can be reviewed, but direct asks and multiple flagged URL occurrences retain hard-link handling (2026-11-22).

- Guided blocks recheck the live contact after rename pacing, preserving newly saved names and saved-contact unblock metadata without cancelling the explicit block (2026-11-22).
- Successful poll and command unblocks append to `BLOCK_LOG_PATH`; recent blocks and history-based 解除 skip unblocked contacts until they are blocked again (2026-11-21).
- Primary LLM archives require a `scam` label and the confidence gate; contradictory `should_archive: true` on non-scam or unknown labels is ignored (2026-11-21).
- Short-link impersonation requires affirmative self-identification or a WhatsApp official header; bare authority mentions and anti-scam advice such as 銀行職員唔會叫你撳 bit.ly/xxx go to mask → LLM rather than rule-only archive (2026-11-21).
- Automatic blocks refresh contact state before blocking and renaming; automatic archives refresh before archiving. A newly saved or unverified contact defers a pending action rather than falling back to automatic archive. A temporary contact written by the same successful block does not prevent the archive. Explicit poll choices still apply to saved contacts.
- Edits invalidate pending guided deliveries as well as open polls, bypassing recommendation cooldown; stale deliveries do not publish new cards, and polls already in flight are registered void.
- Review and unblock choices persist consumption before resolving the in-memory poll. A failed save leaves the choice retryable and notifies the operator without taking action.

- Automatic LLM cooldown starts only after a successful archive; deferred review cooldown starts on the recommendation. Benign and low-confidence reviews do not suppress follow-up messages. An edit that voids a guided poll re-reviews the edited text even during the cooldown; the context review sees the edited text in place of the original.
- Bare-host lookalike checks require a two-letter or common TLD; uncommon-TLD bare hosts remain eligible for malicious-host matching.
- Only a URL or email-domain match on the malicious-host list can bypass AI (`obvious_scam`). Lookalike and short-link hits require masked AI confirmation. Only a malicious-host match on an unsaved contact blocks (`封鎖·惡意域名`). Extend the list in `data/malicious-hosts.json` (optional `MALICIOUS_HOSTS_PATH`). A bare host with no scheme counts. Allowlisted hosts such as `sf-express.com` are not lookalikes, and neither are `github.io`, `medium.com`, or `blogspot.com`. The brand has to start the label, on the registrable name or a subdomain, so `not-hangseng.com` and `not-hangseng.evil.com` do not match; `hsbc.evil.com` and `whatsapp-secure.evil.com` do. A hyphen stays inside the label, so `not-bit.ly` is not a short link. Fullwidth URLs are folded before the check. `youtu.be` is not a short link. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording) do not archive or block. All other DMs: mask → context or primary LLM. No thread window scoring. Edited messages re-run the same path, and an open guided poll for the original text is void: a later vote on it does nothing and the bot says it was void. A phone JID is kept when the paired id is `@lid`.
- A failed archive still messages the operator. The receipt says the archive did not happen. Block, rename, mute, archive, the receipt, and the guided card share one WhatsApp write queue. A message that ends in ignore does not enter that queue.
- Unblock deletes the temporary contact only while its live name still exactly matches the bot-written block name; edited or saved contacts are left alone.
- A mask response that is truncated, short a row, or has a non-integer span is a failed mask. The LLM call is skipped. Empty span lists (no PII) are still success.

- **Live worker role:** PII mask head (`JEVLIKE_MASK_CKPT` / `models/jevlike_hf_pii_mask.pt`). Scam scorer checkpoint (`jevlike-hf-r1`) remains for **lab eval only**, not inbound decisions.
- `jevlike_serve.py` does **not** read `.env` (no dotenv). Export `JEVLIKE_MASK_CKPT` (and optional `JEVLIKE_CKPT` for `/v1/score`) in the shell that starts the worker.
- Primary LLM precision on a labelled real corpus is **not yet published** — use `scripts/review-eval.js` (`--mode all`, `--llm dry|live`). Stub unit tests prove wiring, not FPR/FNR.
- `CONTEXT_LLM_ENABLED` (default **on**) uses the same mask + chat API over the latest messages, the user's own included (default 10, current message included). Model answers do not auto-block. Saved contacts stay unblockable.
- PII masking is a **separate** jevlike `AttentionHead` (`scripts/train_pii_mask.py` →
  `models/jevlike_hf_pii_mask.pt`, gitignored). It is initialised from the r1 head and trained with
  token-level labels, not the stock whole-message scam loss. The scam checkpoint is not overwritten.
  On a synthetic held-out split the char F1 was 1.0; that is not the 366-row HK set. Live `/v1/mask`
  returns only that head's spans. Lure words such as `驗證碼` are cleared from the mask so the later
  model still sees them. Without the head the route returns 503 and nothing is sent.
  `find_mask_spans` remains the training-label helper and the offline stub, not a live fallback.
  Its digit classes are ASCII `[0-9]`, the same characters JavaScript `\d` matches. Fullwidth phones
  and Chinese-numeral phones stay on the training-only extra gold, not on that shared stub.
- Unsaved contacts auto-block only on a current-message malicious-host match. Lookalike and short-link rules need an AI archive recommendation; they do not block. `sf-express.com` and the other allowlisted hosts are not lookalikes. A news quote of 封號 / USDT / 轉數快 / 驗證碼 / 順豐清關 does not hard-hit.
- Before the setup poll is answered (or `OPERATOR_MODE` is set), unsaved chats may be auto-archived but not auto-blocked; suspicious saved chats still get a review card.
  Curated URL and email-domain matches are acted on before mask/LLM, so a slow LLM does not delay their archive or the URL-only block. `guided` forwards a suspicious DM to the operator, explains it only after
  `/v1/mask`, and waits for 封鎖並封存 / 只封存 / 留低. A failed mask skips the explanation and still shows
  the poll. The explanation model cannot take that action. An explicit 封鎖並封存 is the only way a saved
  contact is blocked.  After every completed archive or block (automatic, or a guided 封鎖並封存 / 只封存),
 the bot messages the operator's own chat with the chat-list name, the phone, and the local reason. When a
 block actually succeeded, a follow-up self-chat poll offers **解除封鎖** / **保持封鎖** (archive-only: no poll).
 Unblock does not unarchive; confirmation says the chat may stay archived. The
  optional Cantonese paragraph on an automatic receipt uses the masked transcript only; the name and phone
  are attached locally and are not sent to the chat API. A failed mask still sends the receipt. Choosing 留低 does not.

## Landmines

- Do **not** run `npm audit fix` — it downgrades puppeteer and breaks the bot (see README).
- Do not commit `.env`, `.wwebjs_auth/`, `*.pt`, or HF encoder weights.
- Chromium is not installed by `npm install`: run `npx puppeteer browsers install chrome` before `npm start`.
- This bot is a personal filter on your own account, not a service. WhatsApp Web automation can log the
  session out; keep `.wwebjs_auth/`.

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
- Do not launch `npm start` for routine verification. WhatsApp Web needs an interactive QR login and can log the session out. Chrome for that path is `npx puppeteer browsers install chrome` (not part of `npm ci`).
