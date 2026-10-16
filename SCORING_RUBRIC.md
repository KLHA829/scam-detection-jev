# Scoring rubric

**Scorer:** [jevlike](https://github.com/vinnylarouge/jevlike) with a frozen Hugging Face encoder and choice labels `not_scam` / `scam`. There is no LightJev / `model_v2` path.

```
score = P(scam) × 100
```

Then the same `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` labels as below. There is no per-dimension breakdown from jevlike.

Machine-readable copy: [scoring-rubric.json](scoring-rubric.json). Thresholds can also be overridden with `ARCHIVE_THRESHOLD` / `SAFE_THRESHOLD` in `.env`. Long messages are capped at `jevlikeMaxChars` (default 2000; override with `JEVLIKE_MAX_CHARS`).

End-to-end decision order (score → link rule → optional LLM → graded block): [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented).

## Design goals

- Catch typical **HK / TW / CN + English** WhatsApp DM tropes (FPS, 轉數快, OTP, 順豐清關, 官方封號, USDT).
- Prefer **fewer false archives** on normal chat (dinner plans, splitting a bill, sharing a link) over catching every weak hint.
- Keep **urgency** and **links** weak on their own; they should not archive a saved friend.

jevlike probabilities are **not calibrated**. Thresholds are operational, not scientific. Link rules and optional LLM review exist because a single binary score can be wrong on ordinary language.

## Labels and thresholds

| Label | Rule (defaults) | Archives from score? | Blocks an unsaved contact? |
|-------|-----------------|----------------------|------------------------------|
| `scam` | `score >= 42` (`ARCHIVE_THRESHOLD`) | Yes (`jevlike_score`) | No. A score never blocks. |
| `not_scam` | `score <= 18` (`SAFE_THRESHOLD`) | No | No |
| `unknown` | in between, **or** empty text, **or** jevlike failure | No (unless a link-rule heuristic hits) | No from the score. Auto-block uses the malicious-host list only. |

Saved contacts are never auto-blocked. `BLOCK_ENABLED=false` turns the block column off.

Empty body: skip the worker, `unknown`, `ok: true`.  
Timeout / 5xx / 401 / 422 / invalid response: `unknown`, `ok: false`.

## Worked examples

**Benign (EN):** “Want to grab dinner at 7?”  
Expected: low `P(scam)` → `not_scam` → ignore (even if unsaved).

**Benign (ZH):** 「今晚食飯嗎？我轉帳比你 AA。」  
Money talk without a lookalike or soliciting short link should stay below 42. The link rule does **not** match.

**Scam (ZH OTP + bank):** 「我係銀行職員。你個戶口異常，請即回覆驗證碼並用轉數快轉帳核實。」  
High `P(scam)` → `scam` → archive `jevlike_score`. The wording alone does not archive when the score is low.

**Scam (EN):** “WhatsApp Official: your account will be banned. Click http://bit.ly/x and send the OTP.”  
The ban sentence alone is not a hard hit. The short link plus the OTP ask is `short_link_solicit` even if jevlike is low.

**Scam (parcel):** 「順豐包裹清關費未付 http://bit.ly/fee」  
The 順豐 wording is not a hard hit. A lookalike host would be. This short link without an OTP, impersonation, or urgent account ask is left to the score.

**Urgency only:** 「快啲覆我，立即。」  
Should stay `not_scam` / `unknown`. Saved or unsaved → ignore.

**Clean DM from any number:** unsaved `+1 415 …`, body “Hi” with low score → **ignore** (no foreign-number archive rule). High jevlike score or a heuristic still archives.

## Link backup (archive only)

`lib/link-rules.js` (`matchObviousScam`; disable with `HEURISTIC_ENABLED=false`). Text tropes are not hard hits.

- Lookalike hostname: any hostname label **is** the brand (`hsbc.evil.com`), or **starts** with that brand (`whatsapp-secure.com`, `whatsapp-secure.evil.com`, `sf-express-hk.evil.com`), or is one character off a brand of at least 6 letters (`whatspp`, `whatspp.evil.com`). A bare host counts (`whatsapp-secure.com/login` with no scheme). Fullwidth lookalikes are folded first. A hyphen is part of the label, so `not-bit.ly` is not `bit.ly`. A longer word that merely contains the brand (`bestwhatsapp.com`), a brand that does not start the label (`not-hangseng.com`, `not-hangseng.evil.com`, `my-whatsapp.example.com`), and a short near-miss (`hsb.com`) do not match. Allowlisted suffixes: `whatsapp.com`, `wa.me`, `sf-express.com`, `hsbc.com`, `hsbc.com.hk`, `hangseng.com`, `payme.hsbc.com.hk`. Public hosts `github.io`, `medium.com`, and `blogspot.com` are not lookalikes (`whatsapp.github.io`).
- Short link (`bit.ly`, `tinyurl.com`, `t.co`, `cutt.ly`, `rb.gy`, `is.gd`, `t.cn`, `dwz.cn`, `url.cn`, with or without `https://`) **and** an OTP ask, impersonation, or an urgent transfer into an account. A short link alone, or with ordinary bill-splitting, does not match. `youtu.be` is not a short link.

驗證碼, 轉數快, 封號, USDT, and 順豐清關 wording are not hard hits, including when a news article quotes them. The scorer decides those lines. Optional context LLM and LLM review (default off) never auto-block; a model `block` answer is treated as archive only.

Link hits set `archiveReason: 'obvious_scam'` even when the jevlike score is low. Lookalike and soliciting short-link hits **archive only**; they do not auto-block. A high score can archive; it does not block.

## Malicious-host list (auto-block, unsaved only)

[`data/malicious-hosts.json`](data/malicious-hosts.json) (`MALICIOUS_HOSTS_PATH` optional) holds operator-maintained registrable hosts. A current-message URL whose host matches (exact or suffix) may **block** an unsaved contact and rename the contact `封鎖·惡意域名`. Saved contacts are never auto-blocked. This list is separate from lookalike detection; extend it only for confirmed-malicious domains.

## Tuning

Raise `ARCHIVE_THRESHOLD` if friends’ money talk is archived. Lower it if OTP lures slip through as `unknown`. Link rules stay the only hardcoded backup.
