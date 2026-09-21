# Design decisions

This repository started empty (`README` title only). Product invariants (archive-only, foreign-dial, LID, filters, heuristics) come from the original master prompt. Scoring now defaults to **HF-encoder jevlike** (`not_scam` / `scam`). `SCORER=model_v2` keeps the previous **LightJev** rubric worker.

## Kept

| Decision | Why |
|----------|-----|
| **Archive only** — never `contact.block()` from score or heuristic | Safety: a bad probability must not lock a real person out. Blocking is a separate product-owner policy. |
| Score **every** non-ignored live 1:1 body, including **saved contacts** | Saved ≠ safe; ATO and investment scams often arrive from hijacked contacts. |
| **Unsaved + non-local** archive when the message is clean or `unknown` | Complements text scoring for overseas spam DMs. Local = `852` / `86` / `886`. |
| Exclude **880–883, 888** from being treated as China | Avoids prefix mistakes around `86` / `88x` ITU codes. |
| **LID**: resolve `@lid` before the foreign rule; never use LID digits as a phone | LID identifiers are not country codes. Unresolved LID skips the foreign rule only; scoring still runs. |
| Tight **regex heuristic** (archive only) | Failover when the primary scorer is down or under-confident on copy-paste tropes. Includes OTP harvest (`請提供密碼` / 發給我) so fake anti-scam bait still archives. |
| **Intent-gated suppress** | Warning/self-OTP language (`防騙`, `小心`, `新聞`) suppresses archive **only if** the DM does not also solicit OTP-forward, money transfer, or impersonation+secrecy. |
| Filters: `fromMe`, groups, notification types, official WhatsApp names, `isMe` | Avoids looping on your own chats and WhatsApp system accounts. |
| Session in **`.wwebjs_auth`** via `LocalAuth` | Same operator workflow as a typical `whatsapp-web.js` bot. |
| Optional **Docker** for WhatsApp Web Chromium | jevlike (or LightJev) runs as a sibling Python process so the Node image stays small. |
| Log prefixes `[SCAN]`, `[WARN]`, `[INFO]`, `[OK]`, `[ERROR]` plus score + breakdown | Operator can see why a chat was archived. |
| Startup **top 10** 1:1 sidebar chats: foreign archive **without scoring** | Parity with the described old bot; env `STARTUP_FOREIGN_SCAN`. |
| **Fail closed** to `unknown` on timeout / 5xx / invalid JSON | `unknown` alone does not archive. |

## Improved

| Decision | Why |
|----------|-----|
| **HF-encoder jevlike as primary** (`SCORER=jevlike`) | User request: Pi-portable scoring. Frozen `hfl/chinese-roberta-wwm-ext` + ~2.4 MB head from a GitHub Release. `P(scam)×100` uses the same archive/safe thresholds. Encoder is Hub-downloaded, never git. |
| **`SCORER=model_v2` keeps LightJev** | Previous 10-dimension boolean rubric path stays selectable. Not deleted. |
| Persistent **`jevlike_serve.py` / `lightjev_serve.py`** workers | Official `predict()` / HF `from_pretrained` should not reload on every DM. |
| Short questions + **240-char** state cap on LightJev | LightJev **refuses** (does not truncate) inputs over 256 tokens per candidate. jevlike uses a 2000-char cap; the collator truncates to the checkpoint `context_tokens`. |
| `scoring-rubric.json` + `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` | Tune without code changes. Same numbers for jevlike’s 0–100 `P(scam)` map. |
| In-memory **TTL cache** and **per-chat single-flight** | Dedupes retries and overlapping handlers. |
| In-process **`stub-jevlike.js` / `stub-lightjev.js`** | `npm test` never downloads encoder or 2.4 GB LightJev weights. |
| **Rule-based PII redaction** before any external LLM | HK phones, FPS/PayMe/bank ids, emails, ID-like tokens, light names; URLs reduced to domain. Mapping stays local. |
| **Optional OpenAI-compatible LLM review** | Second pass is any Chat Completions API. Default **off**. `LLM_REVIEW_ALL=0` keeps grey/conflict/high triggers. `LLM_REVIEW_ALL=1` reviews every remaining DM after the scorer (hard archives still skip). Merge default `bonsai`: LLM scam archives; LLM not_scam **releases** score-only archives (`jevlike_score` / `lightjev_score`); unknown/fail keeps primary. `archive_only` never releases. PII is still redacted. |

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
| Committing API keys or model weight files | `.env` gitignored; jevlike head via GitHub Release; encoder and LightJev checkpoints downloaded at worker start. |

## Action matrix (implemented)

Live DM, after filters:

1. `score >= ARCHIVE_THRESHOLD` (label `scam`) → archive `jevlike_score` or `lightjev_score` (any sender). If LLM review is enabled, this **score-only** archive still goes to the second pass when the score is in the grey band, (with `LLM_REVIEW_ON_HIGH`, default true) **score/100 > GREY_MAX**, or `LLM_REVIEW_ALL=1`.
2. Else obvious heuristic (or optional local classifier / RAG) → archive `obvious_scam` / `local_classifier` / `rag_scam_match`. Skip LLM.
3. Else unsaved **and** non-local dial → archive `foreign_number` (low or unknown). Skip LLM.
4. Else if the text is a warning/self-OTP **without** OTP-forward, money-transfer ask, or impersonation+secrecy → **suppress** (ignore). Skip LLM.
5. Else if LLM review is enabled and a **trigger** fires (grey band 0.40–0.85 of score/100, high score above `GREY_MAX`, scorer vs local conflict, short OTP-ish DM, money ask from unknown/new number, **or** `LLM_REVIEW_ALL=1`) → redact PII → LLM. `should_archive` or `label=scam` → archive `llm_review_scam`. `not_scam` **releases** a score-only archive unless `LLM_REVIEW_MERGE=archive_only`. LLM failure → keep a score archive; otherwise `unknown` and do not archive.
6. Else ignore.

Saved contacts are exempt from (3) only. High score and heuristic still archive them unless (4) applies. LLM `not_scam` can later **release** a score-only archive. Unresolved `@lid` is treated as missing digits, so (3) does not fire.
