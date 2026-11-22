# Design decisions

This document explains **why** the live bot behaves as it does. For setup steps, see [README.md](README.md). For threshold numbers and archive reason labels, see [SCORING_RUBRIC.md](SCORING_RUBRIC.md). Agent invariants: [AGENTS.md](AGENTS.md).

Live judgment (since 2026-10-16) is **mask, then OpenAI-compatible LLM**. Local jevlike serves **`POST /v1/mask`**. **`POST /v1/score`** is lab-only. LightJev and `SCORER=model_v2` are removed. There is no foreign-number hard archive.

## Why false blocks matter most

Primary users are elderly. A wrong block cuts off family and caregivers. The bot therefore **never** auto-blocks saved contacts. It auto-blocks unsaved contacts **only** when the current message URL matches [`data/malicious-hosts.json`](data/malicious-hosts.json).

Lookalike hosts and soliciting short links **archive** only. They do not block. Primary and context LLMs **archive** at most. They do not block. Phrase tropes (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording) do not archive or block by themselves.

## Why mask before any external LLM

PII must not leave the machine in clear text. The jevlike **PII head** (`POST /v1/mask`) returns character spans. The bot replaces those spans with `XXX` and sends only redacted text to the chat API. Guided-mode Cantonese explanations use the same mask.

If the mask head is missing, the response is invalid, or the call fails, the bot **skips** the LLM and does not archive (fail closed). There is no regex stub on the live path.

## Why the LLM instead of jevlike score on inbound

HK and TW DMs reuse payment, OTP, courier, and impersonation patterns, but phrase rules alone false-positive on normal elderly chat. Link heuristics catch obvious URL tricks on the **current** message without an API call.

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
| **Link rules + malicious-host list** | Hard archive: lookalike host, soliciting short link, or malicious-host URL outside the warning-only exception. Bare host counts. Allowlisted brands (`sf-express.com`, `whatsapp.com`, `hsbc.com`, …) and hosts like `github.io` are not lookalikes. |
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
| **Warning-word table** and phrase-trope regexes as gates | Link heuristics plus mask and LLM decide text without unsafe links. |
| CAPTCHA solving or scraping third-party sites | Out of scope unless explicitly requested. |
| Committing API keys or weight files | `.env` and `.pt` stay out of git. |

## Action matrix (implemented)

Live DM, after filters:

1. Link rule on the **current** message → archive `obvious_scam`. Skip LLM. Lookalike, soliciting short link, or malicious-host URL. Exception: warning-only scam reports go to masked review (step 2 or 3), regardless of saved status or forwarding metadata. Scam framing and no direct solicitation outside quoted, reported or negated speech are required. Exactly one hard-hit URL occurrence is allowed; genuine-site references are fine. Forwarded lures, mixed solicitations, repeated flagged URLs and second flagged links do not qualify. Allowlisted hosts such as `sf-express.com` are not lookalikes. Phrase tropes are not this step.
2. If `CONTEXT_LLM_ENABLED` (default **on**): mask → context LLM on latest inbound bodies → archive `context_llm` when the model answers `archive` or `block` with confidence ≥ `LLM_REVIEW_MIN_CONFIDENCE`. `no_action`, low confidence, mask failure, or bad reply → **ignore**. Model `block` is archive only. Skipped when step 1 already archived.
3. If `CONTEXT_LLM_ENABLED` is off: mask → primary LLM (`LLM_REVIEW_*`, default on). Label `scam` with confidence at or above `LLM_REVIEW_MIN_CONFIDENCE` (default 0.7) → archive `llm_review_scam`. `should_archive` alone cannot trigger archive. `not_scam` → ignore. Mask failure, LLM off, error, or `unknown` → **ignore**.
4. If the contact is unsaved and the current message hard-hit the **malicious-host** link rule in step 1 → **block** (`封鎖·惡意域名`), mute, archive, append `blocks.jsonl`. Lookalike, short-link and LLM archives stay archive-only.
5. Saved contacts never auto-block. Primary and context LLMs never auto-block.

`OPERATOR_MODE=guided` (or the self-chat poll) computes the same suspicion but waits for **封鎖並封存**, **只封存**, or **留低** before WhatsApp writes. The explanation call is separate and cannot release the card.

Automatic mode runs the steps and sends one receipt to your own chat when a write completes. Choosing **留低** does not archive or block.
