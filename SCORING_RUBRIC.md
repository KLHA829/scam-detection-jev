# Scoring rubric

Classification is **not** a single SCAM / NOT_SCAM model label. OpenJEV answers ten independent **noul** (yes/no probability) questions on the message `state`. Code converts those probabilities into a 0–100 score.

Machine-readable copy: [scoring-rubric.json](scoring-rubric.json). Weights and thresholds can also be overridden with `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` in `.env`.

## Design goals

- Catch typical **HK / TW / CN + English** WhatsApp DM tropes (FPS, 轉數快, OTP, 順豐清關, 官方封號, USDT).
- Prefer **fewer false archives** on normal chat (dinner plans, splitting a bill, sharing a link) over catching every weak hint.
- Keep **urgency** and **links** weak on their own; they should not archive a saved friend.

Probabilities from OpenJEV / Jev are **not calibrated**. Thresholds are operational, not scientific.

## Dimensions

Each question is `type: noul`. The API returns `p = noul` in `[0, 1]`.

| id | What it looks for | Weight |
|----|-------------------|--------|
| `money` | 借錢、轉帳、匯款、send money, wire, bitcoin, USDT | 16 |
| `banking` | 戶口、卡號、銀行、FPS、轉數快、account number, CVV | 14 |
| `login_ato` | OTP、驗證碼、locked account、重設密碼、click link to verify | 18 |
| `impersonation` | 政府、警察、稅務、銀行職員、順豐、WhatsApp 官方 | 16 |
| `credential_harvest` | HKID、證件、passport, selfie “for verification” | 10 |
| `parcel_customs` | 包裹、清關、customs fee, unpaid postage | 8 |
| `prize_job` | 中獎、退稅、兼職, too-good job offer | 6 |
| `crypto_romance` | 保證回報, investment platform, pig-butchering lite | 6 |
| `link_lure` | CTA + suspicious shortener / “click to unlock” | 6 |
| `urgency` | 立即、limited time、否則封號 — **cannot archive alone** | 4 |

Question wording (ZH/EN criteria) lives in `scoring-rubric.json`. One HTTP request sends **all** questions; Jev/OpenJEV evaluates them in parallel on the same `state`.

## Mapping probabilities to points

Noise floor (default `0.45`):

```
f(p) = 0                         if p < 0.45
f(p) = (p - 0.45) / 0.55         otherwise
```

Casual mentions below the floor contribute nothing.

```
raw   = Σ (weight_i × f(p_i))
bonus = 12  if f(money) ≥ 0.6 AND (f(impersonation) ≥ 0.55 OR f(login_ato) ≥ 0.55)
        else 0
score = min(100, raw + bonus)
```

## Labels and thresholds

| Label | Rule (defaults) | Archives from score? |
|-------|-----------------|----------------------|
| `scam` | `score >= 42` (`ARCHIVE_THRESHOLD`) | Yes |
| `not_scam` | `score <= 18` (`SAFE_THRESHOLD`) | No |
| `unknown` | in between, **or** empty text, **or** OpenJEV failure | No (unless foreign-number / heuristic) |

Empty body: skip OpenJEV, `unknown`, `ok: true`.  
Timeout / 5xx / 401 / 422 / invalid response: `unknown`, `ok: false`.

## Worked examples

**Benign (EN):** “Want to grab dinner at 7?”  
Expected: all `p` low → score ≈ 0 → `not_scam` → ignore (even if unsaved **local**).

**Benign (ZH):** 「今晚食飯嗎？我轉帳比你 AA。」  
`money` may tick up; floor + lack of OTP/impersonation should keep score below 42. Heuristic does **not** match (no FPS+立即+轉帳 triple).

**Scam (ZH OTP + bank):** 「我係銀行職員。你個戶口異常，請即回覆驗證碼並用轉數快轉帳核實。」  
High `login_ato`, `banking`, `impersonation`, `money`, `urgency` → combo bonus → `scam` → archive.

**Scam (EN):** “WhatsApp Official: your account will be banned. Click http://bit.ly/x and send the OTP.”  
Heuristic `wa_official_ban` archives even if OpenJEV is low. Score would also be high from `impersonation` + `login_ato` + `link_lure` + `urgency`.

**Scam (parcel):** 「順豐包裹清關費未付 http://bit.ly/fee」  
Heuristic `sf_customs_link` archives. Rubric `parcel_customs` + `link_lure` + `impersonation` also contribute.

**Urgency only:** 「快啲覆我，立即。」  
`urgency` weight 4 at `p=1` → 4 points → `not_scam`. Saved or local unsaved → ignore.

**Foreign clean DM:** unsaved `+1 415 …`, body “Hi” with low score → archive `foreign_number` (policy, not AI). Saved US number → ignore.

## Heuristic backup (archive only)

Tight regexes in `lib/heuristics.js` (disable with `HEURISTIC_ENABLED=false`):

- 驗證碼 / OTP / verification code **and** 過期 / expire
- 轉數快 / FPS **and** 立即/立刻 **and** 轉帳/transfer
- WhatsApp + 官方/official + 封號/ban
- USDT/bitcoin + wallet/錢包 + send/轉
- 順豐 / SF Express + 清關/customs + `http`

These set `archiveReason: 'obvious_scam'` even when the OpenJEV score is low.

## Tuning

Raise `ARCHIVE_THRESHOLD` if friends’ money talk is archived. Lower it if OTP lures slip through as `unknown` (and consider tightening heuristics rather than dropping the noise floor, which would false-positive more). Change weights in `scoring-rubric.json` without rewriting question text.
