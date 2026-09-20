# Design decisions

This repository started empty (`README` title only). There was **no Qwen worker, Scameter client, or existing WhatsApp bot to copy**. Behaviour below reconstructs the product invariants from the master prompt and replaces message classification with OpenJEV/Jev System One scoring.

## Kept

| Decision | Why |
|----------|-----|
| **Archive only** — never `contact.block()` from score or heuristic | Safety: a bad probability must not lock a real person out. Blocking is a separate product-owner policy. |
| Score **every** non-ignored live 1:1 body, including **saved contacts** | Saved ≠ safe; ATO and investment scams often arrive from hijacked contacts. |
| **Unsaved + non-local** archive when the message is clean or `unknown` | Complements text scoring for overseas spam DMs. Local = `852` / `86` / `886`. |
| Exclude **880–883, 888** from being treated as China | Avoids prefix mistakes around `86` / `88x` ITU codes. |
| **LID**: resolve `@lid` before the foreign rule; never use LID digits as a phone | LID identifiers are not country codes. Unresolved LID skips the foreign rule only; scoring still runs. |
| Tight **regex heuristic** plus **offline RAG** (archive only) | Failover when OpenJEV is down or under-confident on copy-paste tropes; zh/yue without fine-tuning LightJev. |
| Filters: `fromMe`, groups, notification types, official WhatsApp names, `isMe` | Avoids looping on your own chats and WhatsApp system accounts. |
| Session in **`.wwebjs_auth`** via `LocalAuth` | Same operator workflow as a typical `whatsapp-web.js` bot. |
| Optional **Docker** with system Chromium, **no model download** | Runtime for WhatsApp Web, not for GGUF. |
| Log prefixes `[SCAN]`, `[WARN]`, `[INFO]`, `[OK]`, `[ERROR]` plus score + breakdown | Operator can see why a chat was archived. |
| Startup **top 10** 1:1 sidebar chats: foreign archive **without scoring** | Parity with the described old bot; env `STARTUP_FOREIGN_SCAN`. |
| **Fail closed** to `unknown` on timeout / 5xx / invalid JSON | `unknown` alone does not archive. |

## Improved

| Decision | Why |
|----------|-----|
| **Node-only** OpenJEV HTTP client (`lib/openjev-client.js`) | One language. Tests and self-hosted OpenJEV do not need `@typesafe-ai/sdk` (which requires an API key at construct time). |
| **Ten noul dimensions** + code-side weights | Jev composite-scoring pattern: atomic yes/no questions, weights owned by us. |
| **Noise floor 0.45** and **urgency weight 4** | Stops “立即” or a passing “轉帳” from archiving friends. |
| **Combo bonus +12** when money co-occurs with impersonation or login ATO | Classic scam shape without raising every dimension’s weight. |
| `scoring-rubric.json` + `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` | Tune without code changes. |
| In-memory **TTL cache** (message id + text hash) and **per-chat single-flight** | Dedupes retries and overlapping handlers. |
| In-process **`stub-openjev.js`** plus optional HTTP stub | `npm test` never calls a live API. |
| Modular `lib/*` with `processIncomingMessage` | Offline tests do not load Puppeteer / WhatsApp. |
| **zh/yue heuristics + offline RAG** over paraphrased templates | Stub OpenJEV ignores language unless `[stub:scam]`; no LightJev fine-tune or GPU. Archive-only (`obvious_scam` / `rag_scam_match`). |

## Why this rubric

HK/TW/CN DM scams cluster on a few tropes: **FPS/轉數快 payment**, **OTP harvest**, **courier customs**, **government/WhatsApp impersonation**, **crypto deposit**. Splitting those into noul questions matches how System One models work (one snap judgment per question). Aggregation in code makes the archive threshold an explicit product choice.

Bias is toward **precision**: default `ARCHIVE_THRESHOLD=42` needs either several strong dimensions or money+ATO/impersonation. That **misses** some mild lures (they stay `unknown` unless the heuristic, RAG template match, or foreign rule fires). That is accepted so ordinary Cantonese chat is not swept into archive.

## Deferred

- Contact **block** policy (explicitly out of default scope).
- Conversation-level / multi-message scoring.
- Image / voice / OCR.
- Claiming that `noul` values are calibrated frequencies.
- Official `@typesafe-ai/sdk` as a hard dependency.
- Live WhatsApp or live OpenJEV in CI.

## Rejected

| Item | Why |
|------|-----|
| Scameter / any external phone or URL registry | Out of scope; no network lookup for numbers. |
| Local GGUF, `llama-cpp-python`, Qwen worker, `qwen_scam_classifier.py` | Replaced by OpenJEV typed decisions. |
| `requirements.txt` / Python runtime | Node-only; nothing to trim. |
| Blocking on score alone | Safety invariant. |
| CAPTCHA solving or scraping third-party sites | Rejected unless asked. |
| Committing API keys | `.env` is gitignored; `.env.example` has empty key. |
| Free-form chat JSON as the primary classifier output | Primary path reads typed `noul` probabilities. |

## Action matrix (implemented)

Live DM, after filters:

1. `score >= ARCHIVE_THRESHOLD` (label `scam`) → archive `openjev_score` (any sender).
2. Else obvious heuristic → archive `obvious_scam`.
3. Else zh/yue template RAG → archive `rag_scam_match`.
4. Else unsaved **and** non-local dial → archive `foreign_number` (low or unknown).
5. Else ignore.

Saved contacts are exempt from (4) only. High score, heuristic, and RAG still archive them. Unresolved `@lid` is treated as missing digits, so (4) does not fire.
