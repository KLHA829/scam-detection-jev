# Scam example corpus (zh / yue)

`scam-examples-zh-yue.jsonl` is a **small, offline** retrieval corpus for HK/CN WhatsApp-style scam tropes.

These lines are **paraphrases** written from public prevention material and widely reported tropes. They are **not** verbatim victim messages, police transcripts, or copies of a real chat log.

| id | lang | Source (advisory / trope, paraphrased) |
|----|------|----------------------------------------|
| `hk_wa_otp_ask` | yue | PCPD public scam advisory |
| `hk_fps_friend` | yue | HK media coverage of WhatsApp clone / FPS “friend borrow” cases |
| `hk_fps_friend2` | yue | Hong Kong Police WhatsApp scam-prevention guidance |
| `hk_wa_phish_sms` | yue | ADCC-style WhatsApp phishing / fake-official alerts |
| `hk_police_impersonate` | yue | Hong Kong Police phone-scam guides (authority + FPS + secrecy) |
| `cn_customs_parcel` | zh | Victoria Police Mandarin community scam advisories (customs / USDT) |
| `cn_bank_otp_link` | zh | Common CN bank-phishing SMS/WhatsApp wording |
| `cn_wa_suspend` | zh | Trade-group “WhatsApp security centre” / transfer-code lures |
| `cn_usdt_rebate` | zh | Common crypto rebate / wallet-deposit tropes |
| `cn_otp_forward` | zh | SPF-style WhatsApp OTP compromise advisories |
| `cn_job_deposit` | zh | Hong Kong Police part-time job / 保证金 scam notices |
| `yue_otp_expire` | yue | Heuristic-aligned HK OTP + FPS urgency wording |
| `zh_sf_customs` | zh | SF Express / customs “pay this link” tropes |
| `yue_icac` | yue | Authority-impersonation (ICAC / freeze account) tropes |
| `zh_romance_crypto` | zh | Romance-to-crypto / “arbitrage” tropes |

Do not treat a RAG hit as proof that a specific victim sent this text. It only means the incoming DM is close to a known **template family**.
