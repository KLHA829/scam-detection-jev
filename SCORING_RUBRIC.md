# Scoring rubric

**Scorer:** [jevlike](https://github.com/vinnylarouge/jevlike) with a frozen Hugging Face encoder and choice labels `not_scam` / `scam`. There is no LightJev / `model_v2` path.

```
score = P(scam) × 100
```

Then the same `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` labels as below. There is no per-dimension breakdown from jevlike.

Machine-readable copy: [scoring-rubric.json](scoring-rubric.json). Thresholds can also be overridden with `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` in `.env`. Long messages are capped at `jevlikeMaxChars` (default 2000; override with `JEVLIKE_MAX_CHARS`).

## Design goals

- Catch typical **HK / TW / CN + English** WhatsApp DM tropes (FPS, 轉數快, OTP, 順豐清關, 官方封號, USDT).
- Prefer **fewer false archives** on normal chat (dinner plans, splitting a bill, sharing a link) over catching every weak hint.
- Keep **urgency** and **links** weak on their own; they should not archive a saved friend.

jevlike probabilities are **not calibrated**. Thresholds are operational, not scientific. Heuristics, the foreign-number rule, and optional LLM review exist because a single binary score can be wrong on ordinary language.

## Labels and thresholds

| Label | Rule (defaults) | Archives from score? |
|-------|-----------------|----------------------|
| `scam` | `score >= 42` (`ARCHIVE_THRESHOLD`) | Yes (`jevlike_score`) |
| `not_scam` | `score <= 18` (`SAFE_THRESHOLD`) | No |
| `unknown` | in between, **or** empty text, **or** jevlike failure | No (unless foreign-number / heuristic) |

Empty body: skip the worker, `unknown`, `ok: true`.  
Timeout / 5xx / 401 / 422 / invalid response: `unknown`, `ok: false`.

## Worked examples

**Benign (EN):** “Want to grab dinner at 7?”  
Expected: low `P(scam)` → `not_scam` → ignore (even if unsaved **local**).

**Benign (ZH):** 「今晚食飯嗎？我轉帳比你 AA。」  
Money talk without OTP/impersonation should stay below 42. Heuristic does **not** match (no FPS+立即+轉帳 triple).

**Scam (ZH OTP + bank):** 「我係銀行職員。你個戶口異常，請即回覆驗證碼並用轉數快轉帳核實。」  
High `P(scam)` → `scam` → archive `jevlike_score`. Heuristic OTP harvest also archives if the score is low.

**Scam (EN):** “WhatsApp Official: your account will be banned. Click http://bit.ly/x and send the OTP.”  
Heuristic `wa_official_ban` archives even if jevlike is low.

**Scam (parcel):** 「順豐包裹清關費未付 http://bit.ly/fee」  
Heuristic `sf_customs_link` archives.

**Urgency only:** 「快啲覆我，立即。」  
Should stay `not_scam` / `unknown`. Saved or local unsaved → ignore.

**Foreign clean DM:** unsaved `+1 415 …`, body “Hi” with low score → archive `foreign_number` (policy, not AI). Saved US number → ignore.

## Heuristic backup (archive only)

Tight regexes in `lib/heuristics.js` (disable with `HEURISTIC_ENABLED=false`):

- 驗證碼 / OTP / verification code **and** 過期 / expire
- OTP / 密碼 **and** 提供 / 轉發 / 發給我 (harvest)
- 我係防騙／銀行／警察… **and** OTP harvest or money ask
- 轉數快 / FPS **and** 立即/立刻 **and** 轉帳/transfer
- WhatsApp + 官方/official + 封號/ban
- USDT/bitcoin + wallet/錢包 + send/轉
- 順豐 / SF Express + 清關/customs + `http`

These set `archiveReason: 'obvious_scam'` even when the jevlike score is low.

Warning-only copy (`防騙` / `小心` / `新聞` telling you **not** to send OTP or money) is suppressed and does **not** archive. Fake anti-scam bait that also asks for a password, OTP forward, or a transfer still archives.

## Tuning

Raise `ARCHIVE_THRESHOLD` if friends’ money talk is archived. Lower it if OTP lures slip through as `unknown` (and consider tightening heuristics rather than relying on the binary score alone).
