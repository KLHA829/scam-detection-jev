# Design decisions

This document explains **why** the live bot behaves as it does. For setup steps, see [README.md](README.md). For threshold numbers and archive reason labels, see [SCORING_RUBRIC.md](SCORING_RUBRIC.md). Agent invariants: [AGENTS.md](AGENTS.md).

Live judgment (since 2026-10-16) is **mask, then OpenAI-compatible LLM**. Local jevlike serves **`POST /v1/mask`**. **`POST /v1/score`** is lab-only. LightJev and `SCORER=model_v2` are removed. There is no foreign-number hard archive.

## Why false blocks matter most

Primary users are elderly. A wrong block cuts off family and caregivers. The bot **never** auto-archives or auto-blocks saved contacts. It auto-blocks unsaved contacts **only** when the current message URL matches [`data/malicious-hosts.json`](data/malicious-hosts.json).

Lookalike hosts and short links go to AI review. They never archive or block by themselves. An email address on a listed domain archives directly but never auto-blocks. Primary and context LLMs **archive** at most. They do not block. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording) do not archive or block by themselves.

## Why mask before any external LLM

PII must not leave the machine in clear text. The jevlike **PII head** (`POST /v1/mask`) returns character spans. The bot replaces those spans with `XXX` and sends only redacted text to the chat API. Guided-mode Cantonese explanations use the same mask.

If the mask head is missing, the response is invalid, or the call fails, the bot **skips** the LLM and does not archive (fail closed). There is no regex stub on the live path.

## Why the LLM instead of jevlike score on inbound

HK and TW DMs reuse payment, OTP, courier, and impersonation patterns, but phrase rules alone false-positive on normal elderly chat. Only a curated URL or email-domain match on the **current** message bypasses AI, subject to the warning-only exception.

Everything else goes through mask and an OpenAI-compatible review (`LLM_REVIEW_ENABLED` default **on**). Archive from the LLM needs `confidence >= LLM_REVIEW_MIN_CONFIDENCE` (default **0.7**). Lower or missing confidence means ignore. Errors and `unknown` mean ignore.

**`CONTEXT_LLM_ENABLED` defaults to on.** The bot sends a masked transcript of the latest inbound bodies (`CONTEXT_LLM_MESSAGES`, default 10). Set `CONTEXT_LLM_ENABLED=0` or `false` to use single-message primary LLM only. A model answer of `block` is treated as archive only.

After a successful primary or context review recommends archive, the same `chatId` skips further mask and LLM for `LLM_REVIEW_COOLDOWN_MS` (default 10 minutes). Automatic mode starts this window after the archive succeeds; guided mode starts it before the operator acts.

The frozen scam head and **`POST /v1/score`** remain for lab scoring (`lab/score-message.js`). They do **not** gate live archive or block.

## Kept

| Decision | Why |
|----------|-----|
| **Graded block** — `contact.block()` only for unsaved contacts on malicious-host match | Operator-maintained list is the only automatic block signal. Block reason becomes contact name and `blocks.jsonl` entry. |
| **Review every** non-ignored 1:1 body (mask then LLM), including saved contacts | Saved contacts are not safe. Account takeover and investment scams arrive from hijacked numbers. |
| **LID** — resolve `@lid` for logs and LLM context; never treat LID digits as a phone | LID is not a country code. Unresolved `@lid` still runs mask and LLM. |
| **Link rules + malicious-host list** | Only a curated URL or email-domain match outside the warning-only exception directly archives. Other rule hits go to masked AI review. Bare host counts. Allowlisted brands (`sf-express.com`, `whatsapp.com`, `hsbc.com`, …) and hosts like `github.io` are not lookalikes. |
| Filters: `fromMe`, groups, notification types, official WhatsApp names, `isMe` | Avoids loops on your own chats and system accounts. |
| Session in **`.wwebjs_auth`** via `LocalAuth` | Standard `whatsapp-web.js` operator workflow. |
| Optional **Docker** for Chromium only | jevlike runs as a sibling Python process. |
| Log prefixes and archive or block reasons | Operator can see why an action ran. No live jevlike score breakdown on inbound. |
| **Fail closed** on timeout, 5xx, or invalid JSON | `unknown` alone does not archive. |

## Improved

| Decision | Why |
|----------|-----|
| **HF-encoder scam head (lab only)** | Frozen `hfl/chinese-roberta-wwm-ext` plus r1 head for `/v1/score` and training. Live inbound uses mask head and LLM. |
| Persistent **`jevlike_serve.py`** | Avoid reloading HF weights on every DM. |
| **`scoring-rubric.json`** and env thresholds | Tune lab eval without code changes. Not live archive gates after mask and LLM. |
| TTL cache and per-chat single-flight | Dedupes retries and overlapping handlers. |
| **Paced WhatsApp writes** | Block, rename, mute, and archive run serially with `WA_ACTION_GAP_MS` (default 3s). Failed block does not save the contact. |
| **Operator mode** — automatic or guided self-chat poll | Guided mode masks before Cantonese explanation. Explanation cannot archive or block. Link rules run before mask and LLM so a slow model does not delay archive or malicious-host block. Receipts attach name and phone locally. |
| ~~Thread window scoring~~ **Removed from live path** | `CONTEXT_TURNS` and `thread-context.js` support review copy and context LLM only. |
| **`stub-jevlike.js`** | `npm test` never downloads the encoder. |
| **Primary OpenAI-compatible LLM review** | See [Why the LLM instead of jevlike score on inbound](#why-the-llm-instead-of-jevlike-score-on-inbound). Hard link archives skip LLM. |

## Deferred

- Conversation-level scoring beyond the context LLM window.
- Image, voice, or OCR.
- Claiming jevlike probabilities are calibrated frequencies.
- Live WhatsApp or live encoder weights in CI.
- Using an LLM to redact PII (mask head handles desensitisation).

## Rejected

| Item | Why |
|------|-----|
| Scameter or any external phone or URL registry | No network lookup for numbers or URLs. |
| Hosted TypeSafe Jev / OpenJEV `POST /v1/systemone` as default | Replaced by local mask head and OpenAI-compatible LLM. |
| LightJev 0.6B / `SCORER=model_v2` | Removed. Not Pi-portable (~2.4 GB). |
| **Foreign-number hard archive** | Removed. Clean DMs from any country code are ignored unless link rules or mask and LLM apply. |
| llama-cpp / GGUF chat as primary classifier | Live path uses Chat Completions after mask. Scam head is lab scorer only. |
| Block saved contacts, block from score alone, block on lookalike or short link | Heuristic or model false positives must not lock someone out. |
| **Warning-word table**, `isWarningOnly`, and phrase-trope regexes as gates | Natural-language regexes break on adversarial/conversational phrasing; structural link rules plus mask and LLM judge intent and warnings. |
| CAPTCHA solving or scraping third-party sites | Out of scope unless explicitly requested. |
| Committing API keys or weight files | `.env` and `.pt` stay out of git. |

## Action matrix (implemented)

Live DM, after filters:

Steps 1–3 compute archive recommendations; step 4 may upgrade one to block. The operator policy in step 5 determines whether anything runs automatically.

1. Structural link check on the **current** message detects curated malicious hosts (`malicious_host`, `malicious_email_host`) and brand lookalikes (`lookalike_domain`). No link rule archives directly without AI, and there are no natural-language warning/intent regexes. Allowlisted hosts such as `sf-express.com` are not lookalikes. Curated malicious-host hits bypass per-chat LLM cooldown and attach a device-checked system prompt note (without leaking the raw hostname) so the LLM distinguishes real lures from anti-scam warnings.
2. If `CONTEXT_LLM_ENABLED` (default **on**): mask → context LLM on latest inbound bodies plus the user's own 1:1 messages (marked `user:`); on a first message from an unsaved number the archive also needs the model's `strong: true` (or a current-message curated malicious-host match) → archive `context_llm` when the model answers `archive` or `block` with confidence ≥ `LLM_REVIEW_MIN_CONFIDENCE`. When the review does not archive but answers `pitch: true` (unsolicited investment, trading or health-product pitch), an **unsaved** sender is renamed `（可疑推銷）` without archiving, blocking or muting; saved contacts keep their name. The bot records each number it names (`BOT_CONTACT_NAMES_PATH`), and only that recorded name does not make the sender a saved contact, so a later scam from it still archives; a contact the user saved under the same text keeps full saved-contact protection. An edit during rename pacing cancels the label. `no_action`, low confidence, mask failure, disabled review, or bad reply → **ignore** (fail closed). Model `block` is archive only unless step 4 applies.
3. If `CONTEXT_LLM_ENABLED` is off: mask → primary LLM (`LLM_REVIEW_*`, default on). Label `scam` with confidence at or above `LLM_REVIEW_MIN_CONFIDENCE` (default 0.7) → archive `llm_review_scam`. `should_archive` alone cannot trigger archive. `not_scam` → ignore. Mask failure, LLM off or unavailable, error, or `unknown` → **ignore**.
4. If step 2 or 3 recommends archive, the contact is unsaved, and the current message matched a **malicious-host URL** in step 1 → **block** (`封鎖·惡意域名`), mute, archive, append `blocks.jsonl`. Email-domain and non-listed LLM archives do not auto-block.
5. Saved contacts always defer recommendations to the operator's self-chat card instead of auto-archiving or auto-blocking, including before setup. Saved status comes from the phone-number contact, also for a `@lid` sender; a sender whose saved status cannot be read is treated the same way. Primary and context LLMs never auto-block.

`OPERATOR_MODE=guided` (or the self-chat poll) computes the same suspicion but waits for **封鎖並封存**, **只封存**, or **留低** before WhatsApp writes. The explanation call is separate and cannot release the card.

Automatic mode runs the steps and sends one receipt to your own chat when a write completes. Choosing **留低** does not archive or block.
