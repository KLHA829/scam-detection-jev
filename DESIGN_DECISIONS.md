# Design decisions

This repository started empty (`README` title only). Product invariants (archive-only, foreign-dial, LID, filters, heuristics) come from the original master prompt. Scoring now uses **LightJev**, not hosted OpenJEV / TypeSafe System One.

## Kept

| Decision | Why |
|----------|-----|
| **Archive only** — never `contact.block()` from score or heuristic | Safety: a bad probability must not lock a real person out. Blocking is a separate product-owner policy. |
| Score **every** non-ignored live 1:1 body, including **saved contacts** | Saved ≠ safe; ATO and investment scams often arrive from hijacked contacts. |
| **Unsaved + non-local** archive when the message is clean or `unknown` | Complements text scoring for overseas spam DMs. Local = `852` / `86` / `886`. |
| Exclude **880–883, 888** from being treated as China | Avoids prefix mistakes around `86` / `88x` ITU codes. |
| **LID**: resolve `@lid` before the foreign rule; never use LID digits as a phone | LID identifiers are not country codes. Unresolved LID skips the foreign rule only; scoring still runs. |
| Tight **regex heuristic** (archive only) | Failover when LightJev is down or under-confident on copy-paste tropes. Includes OTP harvest (`請提供密碼` / 發給我) so fake anti-scam bait still archives. |
| **Intent-gated suppress** | Warning/self-OTP language (`防騙`, `小心`, `新聞`) suppresses archive **only if** the DM does not also solicit OTP-forward, money transfer, or impersonation+secrecy. |
| Filters: `fromMe`, groups, notification types, official WhatsApp names, `isMe` | Avoids looping on your own chats and WhatsApp system accounts. |
| Session in **`.wwebjs_auth`** via `LocalAuth` | Same operator workflow as a typical `whatsapp-web.js` bot. |
| Optional **Docker** for WhatsApp Web Chromium | LightJev runs as a sibling Python process so the Node image stays small. |
| Log prefixes `[SCAN]`, `[WARN]`, `[INFO]`, `[OK]`, `[ERROR]` plus score + breakdown | Operator can see why a chat was archived. |
| Startup **top 10** 1:1 sidebar chats: foreign archive **without scoring** | Parity with the described old bot; env `STARTUP_FOREIGN_SCAN`. |
| **Fail closed** to `unknown` on timeout / 5xx / invalid JSON | `unknown` alone does not archive. |

## Improved

| Decision | Why |
|----------|-----|
| **LightJev boolean records** instead of TypeSafe noul HTTP | User request: score with LightJev’s finite-candidate API (`kind: boolean`, `candidates: ["false","true"]`). `P(true)` is the noul used by the existing rubric. |
| Persistent **`lightjev_serve.py`** worker | Official `predict()` reloads the checkpoint every call. The worker calls `load_checkpoint()` once and batches all rubric questions in one backbone forward. |
| Short questions + **240-char** state cap | LightJev **refuses** (does not truncate) inputs over 256 tokens per candidate. |
| `scoring-rubric.json` + `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` | Tune without code changes. |
| In-memory **TTL cache** and **per-chat single-flight** | Dedupes retries and overlapping handlers. |
| In-process **`stub-lightjev.js`** | `npm test` never downloads 2.4 GB of weights. |
| **Rule-based PII redaction** before any external LLM | HK phones, FPS/PayMe/bank ids, emails, ID-like tokens, light names; URLs reduced to domain. Mapping stays local. |
| **Optional OpenAI-compatible LLM review** on grey/conflict **and** high LightJev scores | Second pass is any Chat Completions API (OpenAI cloud, Ollama, vLLM, llama.cpp `llama-server`, …) — not a single vendor. API key is optional (Bearer only when set). Grey-band still fail-open to `unknown` (do not archive on timeout/5xx alone). High/score-only archives (`lightjev_score`) get an LLM second look when `LLM_REVIEW_ON_HIGH=true` (default once review is enabled). LLM `not_scam` **releases** those score FPs (friend/family meal repay, cab fare). LLM `unknown`/fail **keeps** the score archive. Heuristic / RAG / foreign-number archives stay absolute. PII is still redacted before the LLM. |

## Why this rubric

HK/TW/CN DM scams cluster on a few tropes: **FPS/轉數快 payment**, **OTP harvest**, **courier customs**, **government/WhatsApp impersonation**, **crypto deposit**. Splitting those into boolean questions matches LightJev’s record contract. Aggregation in code makes the archive threshold an explicit product choice.

Bias is toward **precision**: default `ARCHIVE_THRESHOLD=42` needs either several strong dimensions or money+ATO/impersonation. That **misses** some mild lures (they stay `unknown` unless the heuristic or foreign rule fires). That is accepted so ordinary Cantonese chat is not swept into archive.

LightJev-0.6B was trained on synthetic smart-home / catalog tasks. It is **not** a dedicated scam model. Heuristics and the foreign-number rule exist because the checkpoint can be wrong on ordinary language (the upstream authors document a failed cooling-rule probe).

## Deferred

- Contact **block** policy (explicitly out of default scope).
- Conversation-level / multi-message scoring.
- Image / voice / OCR.
- Claiming that LightJev probabilities are calibrated frequencies.
- Fine-tuning LightJev on scam DMs.
- Live WhatsApp or live LightJev weights in CI.
- Using an LLM to redact PII (rule-based only).

## Rejected

| Item | Why |
|------|-----|
| Scameter / any external phone or URL registry | Out of scope; no network lookup for numbers. |
| Hosted TypeSafe Jev / OpenJEV `POST /v1/systemone` as the default | Replaced by LightJev at the user’s request. |
| llama-cpp / GGUF **chat** classification and free-form JSON | LightJev scores declared candidates; it is not a chat completion API. |
| Blocking on score alone | Safety invariant. |
| CAPTCHA solving or scraping third-party sites | Rejected unless asked. |
| Committing API keys or model weight files | `.env` gitignored; checkpoint downloaded at worker start. |

## Action matrix (implemented)

Live DM, after filters:

1. `score >= ARCHIVE_THRESHOLD` (label `scam`) → archive `lightjev_score` (any sender). If LLM review is enabled, this **score-only** archive still goes to the second pass when the score is in the grey band or (with `LLM_REVIEW_ON_HIGH`, default true) **score/100 > GREY_MAX**.
2. Else obvious heuristic (or optional local classifier / RAG) → archive `obvious_scam` / `local_classifier` / `rag_scam_match`. Skip LLM.
3. Else unsaved **and** non-local dial → archive `foreign_number` (low or unknown). Skip LLM.
4. Else if the text is a warning/self-OTP **without** OTP-forward, money-transfer ask, or impersonation+secrecy → **suppress** (ignore). Skip LLM.
5. Else if LLM review is enabled and a **trigger** fires (grey band 0.40–0.85 of score/100, high score above `GREY_MAX`, LightJev vs local conflict, short OTP-ish DM, money ask from unknown/new number) → redact PII → LLM. `should_archive` or `label=scam` → archive `llm_review_scam`. `not_scam` **releases** a score-only archive. LLM failure → keep a score archive; otherwise `unknown` and do not archive.
6. Else ignore.

Saved contacts are exempt from (3) only. High score and heuristic still archive them unless (4) applies. LLM `not_scam` can later **release** a score-only archive. Unresolved `@lid` is treated as missing digits, so (3) does not fire.
