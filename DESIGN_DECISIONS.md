# Design decisions

This repository started empty (`README` title only). Product invariants (graded block, LID, filters, heuristics) come from the original master prompt plus a later block policy. Live judgment is **mask → OpenAI-compatible LLM** (2026-10-16). Local jevlike serves **`POST /v1/mask`**; scam `POST /v1/score` is lab-only. LightJev / `SCORER=model_v2` is gone. There is **no** foreign-number hard archive.

## Kept

| Decision | Why |
|----------|-----|
| **Graded block (elderly precision-first)** — `contact.block()` only for unsaved contacts, and only when the current message URL matches `data/malicious-hosts.json` | Lookalike and soliciting short-link hits archive only. Models do not auto-block. Saved contacts are never auto-blocked. **Live** inbound never archives from jevlike `P(scam)`; mask→LLM (or link heuristics) decides. In **lab** eval, even a jevlike score at `BLOCK_THRESHOLD` (80) only archives — it never auto-blocks. The block reason is saved as the WhatsApp contact name and in `blocks.jsonl`. |
| **Review every** non-ignored live 1:1 body (mask → LLM), including **saved contacts** | Saved ≠ safe; ATO and investment scams often arrive from hijacked contacts. |
| **LID**: resolve `@lid` for logs / LLM context; never use LID digits as a phone | LID identifiers are not country codes. Unresolved `@lid` still runs mask→LLM like any other DM; missing phone digits do not imply a score-based archive. |
| **Link rules + malicious-host list** | Hard archive hits: lookalike host, soliciting short link, or URL on the malicious-host list. A bare host counts. Allowlisted hosts (`sf-express.com`, `whatsapp.com`, `hsbc.com`, …) and public hosts (`github.io`, `medium.com`, `blogspot.com`) are not lookalikes. Only the malicious-host list may auto-block an unsaved contact. |
| Filters: `fromMe`, groups, notification types, official WhatsApp names, `isMe` | Avoids looping on your own chats and WhatsApp system accounts. |
| Session in **`.wwebjs_auth`** via `LocalAuth` | Same operator workflow as a typical `whatsapp-web.js` bot. |
| Optional **Docker** for WhatsApp Web Chromium | jevlike runs as a sibling Python process so the Node image stays small. |
| Log prefixes `[SCAN]`, `[WARN]`, `[INFO]`, `[OK]`, `[ERROR]` plus archive/block reasons and self-chat receipts | Operator can see why a chat was archived or blocked. There is no live jevlike score breakdown on the inbound path. |
| **Fail closed** to `unknown` on timeout / 5xx / invalid JSON | `unknown` alone does not archive. |

## Improved

| Decision | Why |
|----------|-----|
| **HF-encoder jevlike scam head (lab only)** | Frozen `hfl/chinese-roberta-wwm-ext` + r1 head for offline `/v1/score` and training. Live inbound uses mask head + LLM, not `P(scam)` archive. LightJev / `model_v2` is gone. |
| Persistent **`jevlike_serve.py`** worker | HF `from_pretrained` should not reload on every DM. |
| `scoring-rubric.json` + `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` | Tune lab eval without code changes. Same numbers map jevlike’s 0–100 `P(scam)` in **`POST /v1/score`** runs; they are not live archive gates after mask→LLM. |
| In-memory **TTL cache** and **per-chat single-flight** | Dedupes retries and overlapping handlers. |
| **Paced WhatsApp writes** | Block, rename, mute, and archive run one chat at a time, with `WA_ACTION_GAP_MS` (default 3s) between each call. A failed block does not save the contact. |
| **Operator mode** — automatic, or ask in your own chat | First ready session offers a poll: keep graded block/archive, or forward each suspicious DM to yourself. Guided mode masks with `/v1/mask` before a Cantonese explanation. A failed mask skips the explanation and still shows the poll. The explanation cannot archive or block; the poll can. Until that first choice, suspicious chats are archived and not blocked. `OPERATOR_MODE` pins it without asking. A current-message link rule is applied before mask/LLM, so a slow LLM does not delay archive or a malicious-host block. After every completed archive or block, your own chat gets a receipt: the chat-list name (saved address-book name, otherwise the push name, taken before any `封鎖·` rename), the phone, and the local reason. The automatic receipt may add a Cantonese paragraph from the masked transcript only. The name and phone are attached locally and are not sent to the chat API. Mask or model failure still sends the receipt. Choosing 留低 does not. |
| ~~Thread window scoring~~ **Removed from live path (2026-10-16)** | `CONTEXT_TURNS` / `thread-context.js` remain for review copy and optional `CONTEXT_LLM_ENABLED` transcript only. |
| In-process **`stub-jevlike.js`** | `npm test` never downloads the encoder. |
| **jevlike PII head** before any external LLM | `POST /v1/mask` returns character spans from the separate mask head. The bot writes `XXX`. A missing head or a failed mask skips the LLM call. |
| **Primary OpenAI-compatible LLM review** | Required for non-heuristic DMs (`LLM_REVIEW_ENABLED` default **on**). Mask → Chat Completions → archive `llm_review_scam` only when `confidence >= LLM_REVIEW_MIN_CONFIDENCE` (default **0.7**); lower/missing confidence → ignore. Fail closed on mask/LLM failure. After a successful primary or context review (`ok === true`), per-chat mask+LLM is skipped for `LLM_REVIEW_COOLDOWN_MS` (default 10 min). Hard link archives skip the LLM. `CONTEXT_LLM_ENABLED` (default **on**) uses a multi-message masked transcript when not disabled. PII is masked by the jevlike head before any external call. |

## Why mask-then-LLM (score is lab-only)

HK/TW/CN DM scams cluster on payment/OTP/courier/impersonation tropes, but phrase regexes alone false-positive on elderly chat. **Live** judgment is: link heuristics first (malicious-host match wins over lookalike for block eligibility), then **mask → OpenAI-compatible LLM** on everything else. **Auto-block** stays malicious-host-only for unsaved contacts. The jevlike scam score remains for offline eval (`lab/score-message.js`, `scripts/review-eval.js`), not inbound archive.

## Deferred

- Conversation-level / multi-message scoring.
- Image / voice / OCR.
- Claiming that jevlike probabilities are calibrated frequencies.
- Live WhatsApp or live encoder weights in CI.
- Using an LLM to redact PII. Desensitisation is the jevlike mask head.

## Rejected

| Item | Why |
|------|-----|
| Scameter / any external phone or URL registry | Out of scope; no network lookup for numbers. |
| Hosted TypeSafe Jev / OpenJEV `POST /v1/systemone` as the default | Replaced by local jevlike mask head + OpenAI-compatible LLM; scam `POST /v1/score` is lab-only. |
| LightJev 0.6B / `SCORER=model_v2` as a selectable fallback | User request: remove that path entirely. Not Pi-portable (~2.4 GB). |
| chinese-roberta multi-label `model_v2` server | Same: gone for this Pi/jevlike deploy. |
| **Foreign-number / unsaved non-local hard archive** (`foreign_number`, `STARTUP_FOREIGN_SCAN`) | User request: remove the 外國號碼 archive rule. Clean DMs from any country code are ignored unless link heuristics or mask→LLM review applies. No jevlike score hard-archive. |
| llama-cpp / GGUF **chat** as the primary classifier | Live inbound uses OpenAI-compatible Chat Completions after mask (`LLM_REVIEW_ENABLED` default **on**). The jevlike scam head is a frozen-encoder lab scorer (`/v1/score`), not the live chat classifier. |
| Blocking saved contacts, blocking from a jevlike score alone, or auto-blocking on lookalike/short-link heuristics | Heuristic or model false positives must not lock a real person out. Unsaved auto-block is malicious-host-only. Live path does not archive from score alone. |
| **Warning-word table** and **phrase-trope regexes** (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording, self-OTP suppress) as archive or block gates | User request: those rules must not decide. Link heuristics plus mask→primary LLM (default on), or mask→context LLM when `CONTEXT_LLM_ENABLED` is on, decide text with no unsafe link. |
| CAPTCHA solving or scraping third-party sites | Rejected unless asked. |
| Committing API keys or model weight files | `.env` gitignored; jevlike head via GitHub Release; encoder downloaded at worker start. |

## Action matrix (implemented)

Live DM, after filters:

1. Link rule on the **current** message → archive `obvious_scam`. Skip LLM. Lookalike, soliciting short link, or malicious-host URL (including when the text says 這不是詐騙). Allowlisted hosts such as `sf-express.com` are not lookalikes. Wording such as 轉數快, 驗證碼, 封號, or 順豐清關 is not this step.
2. If `CONTEXT_LLM_ENABLED` (default **on**): mask → context LLM on the latest inbound bodies → archive `context_llm` when the model answers `archive` or `block` with confidence ≥ `LLM_REVIEW_MIN_CONFIDENCE`; `no_action`, low confidence, mask failure, or bad reply → **ignore** (fail closed). Model `block` is archive only. Skipped when step 1 already archived (link rule).
3. If `CONTEXT_LLM_ENABLED` is off: mask PII → primary LLM (`LLM_REVIEW_*`, default on). `scam` / `should_archive` → archive `llm_review_scam`. `not_scam` → ignore. Mask failure, LLM off, error, or `unknown` → **ignore** (fail closed).
4. After archive, if the contact is unsaved and the current message matched the **malicious-host list** → **block** (`封鎖·惡意域名`), mute, archive, append `blocks.jsonl`. Lookalike and short-link archives stay archive-only.
5. Saved contacts never auto-block. Primary and context LLMs never auto-block.

`OPERATOR_MODE=guided` (or the self-chat poll) stops after this decision. The steps above still decide that the DM is suspicious, including an enabled decision-changing LLM, but the WhatsApp write waits for **封鎖並封存**, **只封存**, or **留低**. The explanation call is not that LLM: it cannot release the card, and a mask or model failure still shows the local facts. After **封鎖並封存** or **只封存**, the confirmation repeats the chat-list name, the phone, and the local reason, and does not call the model again.

Automatic mode still performs the steps itself. When that write finishes, the same self chat receives one receipt. An unresolved `@lid` says the phone was not resolved. The receipt is not sent to the other person.

`CONTEXT_LLM_ENABLED` (default **on**; set `0` or `false` for single-message primary LLM only) chooses the context path in step 2 instead of step 3. The worker's `POST /v1/mask` returns spans from the PII head (not the r1 scam head, and not the identifier rules). The bot substitutes `XXX` and sends the latest `CONTEXT_LLM_MESSAGES` inbound bodies (default 10, current message included). Older messages fall off the front. The model may answer `archive`, `block`, or `no_action`; `archive` and `block` (with sufficient confidence) archive as `context_llm` only — no auto-block. `no_action` keeps **ignore** (the pre-LLM decision). Link-rule archives still skip the call. A missing head, a failed mask, or an unusable reply leave the decision at ignore. With context off, the primary LLM path uses the same mask.
