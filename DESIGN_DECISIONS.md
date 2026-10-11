# Design decisions

This repository started empty (`README` title only). Product invariants (graded block, LID, filters, heuristics) come from the original master prompt plus a later block policy. Scoring is **HF-encoder jevlike only** (`not_scam` / `scam`). LightJev / `SCORER=model_v2` is gone. There is **no** foreign-number hard archive.

## Kept

| Decision | Why |
|----------|-----|
| **Graded block** — `contact.block()` only for unsaved contacts, and only on a current-message link rule or an explicit context-model `block` | A score, including one at `BLOCK_THRESHOLD` (80), only archives. Saved contacts are never auto-blocked. The reason is saved as the WhatsApp contact name and in `blocks.jsonl`. |
| Score **every** non-ignored live 1:1 body, including **saved contacts** | Saved ≠ safe; ATO and investment scams often arrive from hijacked contacts. |
| **LID**: resolve `@lid` for logs / LLM context; never use LID digits as a phone | LID identifiers are not country codes. Unresolved LID still scores. |
| **Link rules only** | The hardcoded hard hit is a lookalike host, or a short link that also solicits. A bare host counts. Allowlisted hosts (`sf-express.com`, `whatsapp.com`, `hsbc.com`, …) and public hosts (`github.io`, `medium.com`, `blogspot.com`) are not lookalikes. On an unsaved contact that hit blocks. |
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
| **Paced WhatsApp writes** | Block, rename, mute, and archive run one chat at a time, with `WA_ACTION_GAP_MS` (default 3s) between each call. A failed block does not save the contact. |
| **Operator mode** — automatic, or ask in your own chat | First ready session offers a poll: keep graded block/archive, or forward each suspicious DM to yourself. Guided mode masks with `/v1/mask` before a Cantonese explanation. A failed mask skips the explanation and still shows the poll. The explanation cannot archive or block; the poll can. Until that first choice, suspicious chats are archived and not blocked. `OPERATOR_MODE` pins it without asking. A current-message obvious-scam heuristic is applied before the scorer, so a slow score does not delay the block. After every completed archive or block, your own chat gets a receipt: the chat-list name (saved address-book name, otherwise the push name, taken before any `封鎖·` rename), the phone, and the local reason. The automatic receipt may add a Cantonese paragraph from the masked transcript only. The name and phone are attached locally and are not sent to the chat API. Mask or model failure still sends the receipt. Choosing 留低 does not. |
| **Thread window for grey or short messages** | Score the current body, then the last `CONTEXT_TURNS` inbound bodies (default 4, memory only). Use the higher score unless the current sentence is longer than `CONTEXT_BENIGN_MIN_CHARS` and at or below the safe threshold. Blocking still uses only this message: a window score, or a link that appears only in earlier text, can archive, and does not block. |
| In-process **`stub-jevlike.js`** | `npm test` never downloads the encoder. |
| **jevlike PII head** before any external LLM | `POST /v1/mask` returns character spans from the separate mask head. The bot writes `XXX`. A missing head or a failed mask skips the LLM call. |
| **Optional OpenAI-compatible LLM review** | Second pass is any Chat Completions API. Default **off**. `LLM_REVIEW_ALL=0` keeps grey/conflict/high triggers. `LLM_REVIEW_ALL=1` reviews every remaining DM after the scorer (hard archives still skip). Merge default `bonsai`: LLM scam archives; LLM not_scam **releases** score-only archives (`jevlike_score`); unknown/fail keeps primary. `archive_only` never releases. PII is still masked by the jevlike head. |

## Why this scorer

HK/TW/CN DM scams cluster on a few tropes: **FPS/轉數快 payment**, **OTP harvest**, **courier customs**, **government/WhatsApp impersonation**, **crypto deposit**. jevlike answers a single `not_scam` / `scam` choice. Text without an unsafe link follows that score, and the optional context LLM when it is on. The only hardcoded backup is a lookalike host or a soliciting short link.

Bias is toward **precision**: default `ARCHIVE_THRESHOLD=42` needs a fairly high `P(scam)`. Mild lures without an unsafe link stay `unknown` until the score or the context LLM flags them. That is accepted so ordinary Cantonese chat is not swept into archive.

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
| Hosted TypeSafe Jev / OpenJEV `POST /v1/systemone` as the default | Replaced by local scoring; now jevlike only. |
| LightJev 0.6B / `SCORER=model_v2` as a selectable fallback | User request: remove that path entirely. Not Pi-portable (~2.4 GB). |
| chinese-roberta multi-label `model_v2` server | Same: gone for this Pi/jevlike deploy. |
| **Foreign-number / unsaved non-local hard archive** (`foreign_number`, `STARTUP_FOREIGN_SCAN`) | User request: remove the 外國號碼 archive rule. Clean low-score DMs from any country code are ignored. Score, heuristic, RAG, and optional LLM still apply. |
| llama-cpp / GGUF **chat** as the primary classifier | jevlike is a frozen-encoder choice scorer, not a chat completion API. LLM review remains optional and separate. |
| Blocking saved contacts, or blocking from a jevlike score alone | A score false positive must not lock a real person out. Unsaved contacts block on a link rule or an explicit context-model `block`. |
| **Warning-word table** and **phrase-trope regexes** (驗證碼, 轉數快, 封號, USDT, 順豐清關 wording, self-OTP suppress) as archive or block gates | User request: those rules must not decide. The score and the optional context LLM decide text that has no unsafe link. |
| CAPTCHA solving or scraping third-party sites | Rejected unless asked. |
| Committing API keys or model weight files | `.env` gitignored; jevlike head via GitHub Release; encoder downloaded at worker start. |

## Action matrix (implemented)

Live DM, after filters:

1. `score >= ARCHIVE_THRESHOLD` (label `scam`) → archive `jevlike_score` (any sender). If LLM review is enabled, this **score-only** archive still goes to the second pass when the score is in the grey band, (with `LLM_REVIEW_ON_HIGH`, default true) **score/100 > GREY_MAX**, or `LLM_REVIEW_ALL=1`.
2. Else a link rule (or optional local classifier / RAG) → archive `obvious_scam` / `local_classifier` / `rag_scam_match`. Skip LLM. The link rule is a lookalike host or a soliciting short link, including when the text says 這不是詐騙. An allowlisted host such as `sf-express.com` is not a lookalike. Wording such as 轉數快, 驗證碼, 封號, or 順豐清關 is not this step.
3. Else if LLM review is enabled and a **trigger** fires (grey band 0.40–0.85 of score/100, high score above `GREY_MAX`, scorer vs local conflict, short OTP-ish DM, money ask from unknown/new number, **or** `LLM_REVIEW_ALL=1`) → mask PII → LLM. `should_archive` or `label=scam` → archive `llm_review_scam`. `not_scam` **releases** a score-only archive unless `LLM_REVIEW_MERGE=archive_only`. LLM failure → keep a score archive; otherwise `unknown` and do not archive.
4. Else ignore.

After that, if the final action is still archive **and** the contact is unsaved:

5. Current-message link rule → **block**. Or, when context LLM is on and answers `block`, **block**. Write `封鎖·<reason>` as the WhatsApp contact name, mute, archive, append `blocks.jsonl`. A score at or above `BLOCK_THRESHOLD` stays an archive.
6. Otherwise leave the archive as archive. Scores, RAG-only hits, and `unknown` do not block.

Saved contacts never take the block step. LLM `not_scam` can **release** a score-only archive before the block policy runs, so a released chat is not blocked. Link-rule hits skip the LLM and still block when the contact is unsaved.

`OPERATOR_MODE=guided` (or the self-chat poll) stops after this decision. The steps above still decide that the DM is suspicious, including an enabled decision-changing LLM, but the WhatsApp write waits for **封鎖並封存**, **只封存**, or **留低**. The explanation call is not that LLM: it cannot release the card, and a mask or model failure still shows the local facts. After **封鎖並封存** or **只封存**, the confirmation repeats the chat-list name, the phone, and the local reason, and does not call the model again.

Automatic mode still performs the steps itself. When that write finishes, the same self chat receives one receipt. An unresolved `@lid` says the phone was not resolved. The receipt is not sent to the other person.

`CONTEXT_LLM_ENABLED` (default off) replaces the single-message second pass. The worker's `POST /v1/mask` returns spans from the PII head (not the r1 scam head, and not the identifier rules). The bot substitutes `XXX` and sends the latest `CONTEXT_LLM_MESSAGES` inbound bodies (default 10, current message included). Older messages fall off the front. The model may answer `archive`, `block`, or `no_action`. `block` blocks an unsaved contact and only archives a saved one. `no_action` can release a score-only archive below the block line, and cannot release a block-line score. Link-rule archives still skip the call. A missing head, a failed mask, and an unusable reply leave the primary decision unchanged. The single-message second pass uses the same mask.
