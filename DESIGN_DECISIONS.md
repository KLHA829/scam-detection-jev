# Design decisions

This repository started empty (`README` title only). Product invariants (graded block, LID, filters, heuristics) come from the original master prompt plus a later block policy. Scoring is **HF-encoder jevlike only** (`not_scam` / `scam`). LightJev / `SCORER=model_v2` is gone. There is **no** foreign-number hard archive.

## Kept

| Decision | Why |
|----------|-----|
| **Graded block** — `contact.block()` only for unsaved contacts, and only on an obvious-scam heuristic or jevlike score ≥ `BLOCK_THRESHOLD` (default 80) | Archive threshold 42 is too low to lock a person out. Saved contacts are never auto-blocked. The reason is saved as the WhatsApp contact name and in `blocks.jsonl`. |
| Score **every** non-ignored live 1:1 body, including **saved contacts** | Saved ≠ safe; ATO and investment scams often arrive from hijacked contacts. |
| **LID**: resolve `@lid` for logs / LLM context; never use LID digits as a phone | LID identifiers are not country codes. Unresolved LID still scores. |
| Tight **regex heuristic** | Failover when the scorer is down or under-confident on copy-paste tropes. Includes OTP harvest (`請提供密碼` / 發給我) so fake anti-scam bait still archives. On an unsaved contact the same hit blocks. |
| **Intent-gated suppress** | Warning/self-OTP language (`防騙`, `小心`, `新聞`) suppresses archive **only if** the DM does not also solicit OTP-forward, money transfer, or impersonation+secrecy. |
| Filters: `fromMe`, groups, notification types, official WhatsApp names, `isMe` | Avoids looping on your own chats and WhatsApp system accounts. |
| Session in **`.wwebjs_auth`** via `LocalAuth` | Same operator workflow as a typical `whatsapp-web.js` bot. |
| Optional **Docker** for WhatsApp Web Chromium | jevlike runs as a sibling Python process so the Node image stays small. |
| Log prefixes `[SCAN]`, `[WARN]`, `[INFO]`, `[OK]`, `[ERROR]` plus score + breakdown | Operator can see why a chat was archived. |
| **Fail closed** to `unknown` on timeout / 5xx / invalid JSON | `unknown` alone does not archive. |

## Improved

| Decision | Why |
|----------|-----|
| **HF-encoder jevlike is the only scorer** | User request: Pi-portable scoring, then delete the LightJev / `model_v2` path. Frozen `hfl/chinese-roberta-wwm-ext` + ~2.4 MB head from a GitHub Release. `P(scam)×100` uses archive/safe thresholds. Encoder is Hub-downloaded, never git. |
| Persistent **`jevlike_serve.py`** worker | HF `from_pretrained` should not reload on every DM. |
| `scoring-rubric.json` + `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` | Tune without code changes. Same numbers for jevlike’s 0–100 `P(scam)` map. |
| In-memory **TTL cache** and **per-chat single-flight** | Dedupes retries and overlapping handlers. |
| **Paced WhatsApp writes** | Rename, block, mute, and archive run one chat at a time, with `WA_ACTION_GAP_MS` (default 3s) between each call. |
| **Thread window for grey or short messages** | Score the current body, then the last `CONTEXT_TURNS` inbound bodies (default 4, memory only). Use the higher score unless the current sentence is longer than `CONTEXT_BENIGN_MIN_CHARS` and at or below the safe threshold. Blocking still uses only this message: a window score or a regex that appears only in earlier text can archive, and does not block. |
| In-process **`stub-jevlike.js`** | `npm test` never downloads the encoder. |
| **Rule-based PII redaction** before any external LLM | HK phones, FPS/PayMe/bank ids, emails, ID-like tokens, light names; URLs reduced to domain. Mapping stays local. |
| **Optional OpenAI-compatible LLM review** | Second pass is any Chat Completions API. Default **off**. `LLM_REVIEW_ALL=0` keeps grey/conflict/high triggers. `LLM_REVIEW_ALL=1` reviews every remaining DM after the scorer (hard archives still skip). Merge default `bonsai`: LLM scam archives; LLM not_scam **releases** score-only archives (`jevlike_score`); unknown/fail keeps primary. `archive_only` never releases. PII is still redacted. |

## Why this scorer

HK/TW/CN DM scams cluster on a few tropes: **FPS/轉數快 payment**, **OTP harvest**, **courier customs**, **government/WhatsApp impersonation**, **crypto deposit**. jevlike answers a single `not_scam` / `scam` choice; heuristics and optional LLM review still cover those tropes when the binary score is wrong.

Bias is toward **precision**: default `ARCHIVE_THRESHOLD=42` needs a fairly high `P(scam)`. That **misses** some mild lures (they stay `unknown` unless the heuristic fires). That is accepted so ordinary Cantonese chat is not swept into archive.

## Deferred

- Conversation-level / multi-message scoring.
- Image / voice / OCR.
- Claiming that jevlike probabilities are calibrated frequencies.
- Live WhatsApp or live encoder weights in CI.
- Using an LLM to redact PII (rule-based only).

## Rejected

| Item | Why |
|------|-----|
| Scameter / any external phone or URL registry | Out of scope; no network lookup for numbers. |
| Hosted TypeSafe Jev / OpenJEV `POST /v1/systemone` as the default | Replaced by local scoring; now jevlike only. |
| LightJev 0.6B / `SCORER=model_v2` as a selectable fallback | User request: remove that path entirely. Not Pi-portable (~2.4 GB). |
| chinese-roberta multi-label `model_v2` server | Same: gone for this Pi/jevlike deploy. |
| **Foreign-number / unsaved non-local hard archive** (`foreign_number`, `STARTUP_FOREIGN_SCAN`) | User request: remove the 外國號碼 archive rule. Clean low-score DMs from any country code are ignored. Score, heuristic, RAG, and optional LLM still apply. |
| llama-cpp / GGUF **chat** as the primary classifier | jevlike is a frozen-encoder choice scorer, not a chat completion API. LLM review remains optional and separate. |
| Blocking saved contacts, or blocking at `ARCHIVE_THRESHOLD` alone | A 42-score false positive must not lock a real person out. Unsaved contacts block only at `BLOCK_THRESHOLD` (default 80) or on an obvious-scam heuristic. |
| CAPTCHA solving or scraping third-party sites | Rejected unless asked. |
| Committing API keys or model weight files | `.env` gitignored; jevlike head via GitHub Release; encoder downloaded at worker start. |

## Action matrix (implemented)

Live DM, after filters:

1. `score >= ARCHIVE_THRESHOLD` (label `scam`) → archive `jevlike_score` (any sender). If LLM review is enabled, this **score-only** archive still goes to the second pass when the score is in the grey band, (with `LLM_REVIEW_ON_HIGH`, default true) **score/100 > GREY_MAX**, or `LLM_REVIEW_ALL=1`.
2. Else obvious heuristic (or optional local classifier / RAG) → archive `obvious_scam` / `local_classifier` / `rag_scam_match`. Skip LLM.
3. Else if the text is a warning/self-OTP **without** OTP-forward, money-transfer ask, or impersonation+secrecy → **suppress** (ignore). Skip LLM.
4. Else if LLM review is enabled and a **trigger** fires (grey band 0.40–0.85 of score/100, high score above `GREY_MAX`, scorer vs local conflict, short OTP-ish DM, money ask from unknown/new number, **or** `LLM_REVIEW_ALL=1`) → redact PII → LLM. `should_archive` or `label=scam` → archive `llm_review_scam`. `not_scam` **releases** a score-only archive unless `LLM_REVIEW_MERGE=archive_only`. LLM failure → keep a score archive; otherwise `unknown` and do not archive.
5. Else ignore.

After that, if the final action is still archive **and** the contact is unsaved:

6. Obvious-scam heuristic, or jevlike score ≥ `BLOCK_THRESHOLD` (default 80, and the scorer did not fail) → **block**. Write `封鎖·<reason>` as the WhatsApp contact name, mute, archive, append `blocks.jsonl`.
7. Otherwise leave the archive as archive. Grey scores, RAG-only hits, and `unknown` do not block.

Saved contacts never take step 6. LLM `not_scam` can **release** a score-only archive before the block policy runs, so a released chat is not blocked. Heuristic hits skip the LLM and still block when the contact is unsaved.

`CONTEXT_LLM_ENABLED` (default off) replaces step 4. The worker's `POST /v1/mask` returns identifier character spans (not the r1 scam head). The bot substitutes `XXX`, runs `redactPii` again, and sends the latest `CONTEXT_LLM_MESSAGES` inbound bodies (default 10, current message included). Older messages fall off the front. The model may answer `archive`, `block`, or `no_action`. `block` does not lock anyone out by itself. `no_action` can release a score-only archive below the block line, and cannot release a block-line score. Heuristic archives still skip the call. Mask failure and an unusable reply leave the primary decision unchanged.
