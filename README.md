# scam-detection-jev

Local **WhatsApp Web** bot that scores each 1:1 DM with **[LightJev](https://github.com/rongxinzy/LightJev)** typed decisions and **archives** high-risk chats.

It does **not** block contacts from the score. It does **not** call Scameter or any phone/URL registry. It does **not** use llama-cpp / GGUF chat.

LightJev returns **uncalibrated candidate probabilities** (boolean `false`/`true` softmax). Treat archives as a review queue, not a verdict. The published 0.6B checkpoint is a synthetic-domain research model, not a general business classifier.

## What it does

1. Reads 1:1 message bodies (including saved contacts).
2. Maps each rubric dimension to a LightJev **boolean** record (`candidates: ["false", "true"]`) with the message as `state`.
3. A local Python worker keeps the checkpoint loaded and scores all questions in one batch (`POST /predict`).
4. Aggregates `P(true)` values into one 0–100 score.
5. **Archives** when the score is at or above the archive threshold, when a tight regex heuristic fires, or when an **unsaved non-local** number messages you (HK `852` / CN `86` / TW `886` are local; `880–883` and `888` are not treated as China).
6. Optional startup pass: first **10** sidebar 1:1 chats, **foreign-number archive only** (no scoring).

Filters drop `fromMe`, groups, notification types, your own account, and official WhatsApp names. `@lid` chats are resolved to a real number before the foreign-number rule; LID digits are never used as a phone.

LightJev refuses inputs over **256 tokens** per candidate (state + question + candidate + prompt). Message bodies are truncated to 240 characters.

## Setup

Requires **Node.js 20+**, **Python 3.10+**, and a WhatsApp account you are allowed to link via WhatsApp Web.

```bash
cp .env.example .env
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
npm install

# terminal 1 — loads ~2.4 GB of LightJev-0.6B weights on first run
python lightjev_serve.py

# terminal 2
npm start
```

Scan the QR code. Session files stay in `.wwebjs_auth/` (gitignored).

Set `LIGHTJEV_DEVICE=cuda` if you have a compatible NVIDIA GPU. CPU works and is slower.

### LightJev

| Variable | Default | Meaning |
|----------|---------|---------|
| `LIGHTJEV_BASE_URL` | `http://127.0.0.1:8765` | Worker root. Client posts `{records}` to `{base}/predict`. |
| `LIGHTJEV_API_KEY` | _(empty)_ | Optional Bearer token; must match the worker if set. |
| `LIGHTJEV_TIMEOUT_MS` | `30000` | Per-attempt HTTP timeout. |
| `LIGHTJEV_CHECKPOINT` | `rongxinzy/LightJev-0.6B-v0.1` | Hub id or local folder with `manifest.json`. Worker only. |
| `LIGHTJEV_DEVICE` | `cpu` | `cpu` or `cuda`. Worker only. |
| `LIGHTJEV_TEMPERATURE` | `1` | Softmax temperature (LightJev default; fitted T did not help held-out CE). |

For offline development without downloading weights:

```bash
npm run stub
# LIGHTJEV_BASE_URL=http://127.0.0.1:8765 npm start
```

Include `[stub:scam]` in a message body to force the stub’s high-risk preset.

### Scoring knobs (no code change)

See [SCORING_RUBRIC.md](SCORING_RUBRIC.md) and [scoring-rubric.json](scoring-rubric.json).

- `ARCHIVE_THRESHOLD` (default `42`) — label `scam` / archive from score
- `SAFE_THRESHOLD` (default `18`) — label `not_scam`
- `HEURISTIC_ENABLED` (default `true`)
- `STARTUP_FOREIGN_SCAN` (default `true`)
- `SCORE_CACHE_TTL_MS` (default `900000`)
- `RUBRIC_PATH` — override JSON path
- `LLM_REVIEW_ENABLED` (default `false`)
- `LLM_REVIEW_GREY_MIN` / `LLM_REVIEW_GREY_MAX` (defaults `0.40` / `0.85`, score/100)
- `LLM_REVIEW_OTP_MAX_CHARS` (default `96`)
- `LLM_REVIEW_API_URL` or `OPENAI_BASE_URL` / `OPENAI_API_BASE`
- `LLM_REVIEW_API_KEY` or `OPENAI_API_KEY`
- `LLM_REVIEW_MODEL` (default `gpt-4o-mini`)
- `LLM_REVIEW_TIMEOUT_MS` (default `8000`)

If LightJev times out, returns 5xx, or sends invalid JSON, the label is **`unknown`**. Unknown **does not archive** unless the foreign-number rule or heuristic fires.

## Second-pass review (grey / conflict)

LightJev scoring is unchanged. After it, obvious heuristics, optional local/RAG matchers, and the foreign-number rule, a **second pass** can run on uncertain DMs only:

1. **High-confidence archive** (`lightjev_score`, `obvious_scam`, `rag_scam_match`, `local_classifier`, `foreign_number`) → archive immediately. No LLM.
2. **Intent-gated suppress** — copy that only warns (`防騙` / `小心` / `新聞` / self-OTP) is **not** archived. Fake 「我係防騙協調中心…請提供密碼/轉帳」 is **not** suppressed, because it also solicits OTP, money, or impersonation+secrecy.
3. **Grey / conflict → redact → LLM** (when `LLM_REVIEW_ENABLED=true`):
   - score in grey band `LLM_REVIEW_GREY_MIN`–`LLM_REVIEW_GREY_MAX` (defaults **0.40–0.85**, i.e. LightJev score/100) and not already hard-archived
   - LightJev vs local/heuristic conflict (including money/OTP solicitation vs a `not_scam` label)
   - short OTP-ish message (`LLM_REVIEW_OTP_MAX_CHARS`, default 96)
   - money ask from an unsaved / new / non-local number
4. Rule-based PII redaction (`lib/redact.js`, **no LLM**) replaces HK phones `[電話]`, bank/FPS/PayMe `[戶口]`, emails `[電郵]`, ID-like `[證件]`, easy names `[姓名]`, and strips URL paths to the domain. A local mapping may be kept in memory for logs; it is **never** sent to the LLM.
5. OpenAI-compatible `POST …/v1/chat/completions` (`lib/llm-review.js`) must return JSON `{ label, confidence, signals, should_archive, reason }`. `should_archive` or `label=scam` archives as `llm_review_scam`. Timeout / 5xx / invalid JSON → **unknown**, fail-open, **do not archive** on the LLM error alone.

Disable the LLM (`LLM_REVIEW_ENABLED=false`, default) for a LightJev-only deploy.

## 第二輪覆核（不確定訊息）

流程維持：**LightJev／現有 heuristic／本地分類／RAG → 高風險即時 archive**，不會為了 LLM 拿掉現有計分。

- 已達 archive 門檻或 heuristic／RAG 命中 → **立刻 archive，不呼叫 LLM**
- 灰帶（預設分數/100 介乎 0.40–0.85 且尚未 hard archive）、LightJev 與本地規則衝突、短 OTP、未知號碼要錢 → **先規則遮罩 PII**（電話／戶口／電郵／證件；不用 LLM 做遮罩）→ 再大模型覆核
- LLM 逾時或失敗 → 當 `unknown`，**不會單憑 LLM 錯誤而 archive**
- 抑制改為意圖閘門：純防騙新聞／「小心」提醒不 archive；假冒「防騙」兼要驗證碼／轉帳仍會 archive

設定見 `.env.example`（`LLM_REVIEW_*`、`OPENAI_BASE_URL` / `OPENAI_API_KEY` 亦可）。可接雲端 API 或本地 Ollama／vLLM。

## Tests

`npm test` is **offline**: in-process stub probabilities, no live WhatsApp, no LightJev weight download.

```bash
npm test
```

## Docker (optional)

The Node image runs WhatsApp Web (Chromium) only. Run LightJev as a sibling process and point `LIGHTJEV_BASE_URL` at it.

```bash
docker build -t scam-detection-jev .
docker run --rm -it \
  -e LIGHTJEV_BASE_URL=http://host.docker.internal:8765 \
  -v "$(pwd)/.wwebjs_auth:/app/.wwebjs_auth" \
  scam-detection-jev
```

QR login still needs a terminal that can show the code (or inspect container logs).

## Layout

- `whatsapp-bot.js` — WhatsApp Web client, QR, archive-only actions
- `lib/lightjev-client.js` — maps noul questions → LightJev boolean records; reads `P(true)`
- `lib/redact.js` — rule-based PII redaction before any external LLM call
- `lib/llm-review.js` — optional OpenAI-compatible second pass (grey / conflict only)
- `lib/scam-intent.js` — intent-gated suppress (warning vs OTP/money solicitation)
- `lightjev_serve.py` — persistent checkpoint worker (`POST /predict`)
- `stub-lightjev.js` — fixed probabilities for tests and local HTTP stub
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — kept / improved / deferred / rejected

## Disclaimer

This is a personal archive helper. WhatsApp Web automation can violate WhatsApp’s terms and may get the session logged out. Do not use it on other people’s accounts. Scores are **un-calibrated model probabilities** composed with hand-set weights — review every archive before you treat it as a scam.
