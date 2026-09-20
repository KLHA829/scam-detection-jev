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
- `LLM_REVIEW_ON_HIGH` (default `true` — used only when LLM review is enabled)
- `LLM_REVIEW_GREY_MIN` / `LLM_REVIEW_GREY_MAX` (defaults `0.40` / `0.85`, score/100; `GREY_MAX` is also the high-score second-look line)
- `LLM_REVIEW_OTP_MAX_CHARS` (default `96`)
- `LLM_REVIEW_API_URL` or `OPENAI_BASE_URL` / `OPENAI_API_BASE`
- `LLM_REVIEW_API_KEY` or `OPENAI_API_KEY`
- `LLM_REVIEW_MODEL` (default `gpt-4o-mini`)
- `LLM_REVIEW_TIMEOUT_MS` (default `8000`)

If LightJev times out, returns 5xx, or sends invalid JSON, the label is **`unknown`**. Unknown **does not archive** unless the foreign-number rule or heuristic fires.

## Second-pass review (grey / conflict / high score)

LightJev scoring is unchanged. After it, obvious heuristics, optional local/RAG matchers, and the foreign-number rule, a **second pass** can run when `LLM_REVIEW_ENABLED=true`:

1. **Non-score hard archive** (`obvious_scam`, `rag_scam_match`, `local_classifier`, `foreign_number`) → archive immediately. No LLM. Heuristic/RAG hits also skip the LLM even if LightJev already chose `lightjev_score`.
2. **Intent-gated suppress** — copy that only warns (`防騙` / `小心` / `新聞` / self-OTP) is **not** archived. Fake 「我係防騙協調中心…請提供密碼/轉帳」 is **not** suppressed, because it also solicits OTP, money, or impersonation+secrecy.
3. **Grey / conflict / high → redact → LLM**:
   - score in grey band `LLM_REVIEW_GREY_MIN`–`LLM_REVIEW_GREY_MAX` (defaults **0.40–0.85**, LightJev score/100), including score-only archives in that band
   - high primary score when `LLM_REVIEW_ON_HIGH=true` (default): **score/100 > `LLM_REVIEW_GREY_MAX`**, even if LightJev already archived as `lightjev_score`
   - LightJev vs local/heuristic conflict (including money/OTP solicitation vs a `not_scam` label)
   - short OTP-ish message (`LLM_REVIEW_OTP_MAX_CHARS`, default 96)
   - money ask from an unsaved / new / non-local number
4. Rule-based PII redaction (`lib/redact.js`, **no LLM**) replaces HK phones `[電話]`, bank/FPS/PayMe `[戶口]`, emails `[電郵]`, ID-like `[證件]`, easy names `[姓名]`, and strips URL paths to the domain. A local mapping may be kept in memory for logs; it is **never** sent to the LLM.
5. OpenAI-compatible `POST …/v1/chat/completions` (`lib/llm-review.js`) must return JSON `{ label, confidence, signals, should_archive, reason }`. Merge policy:
   - `should_archive` or `label=scam` → archive `llm_review_scam`
   - `label=not_scam` on a **score-only** archive (`lightjev_score`) → **release** to ignore (friend/family false positives such as meal FPS repay)
   - `unknown` / timeout / 5xx / invalid JSON → **keep** a score archive (fail toward scam on high); grey-band messages that were not already archived still **fail-open** (do not archive on the LLM error alone)

Disable the LLM (`LLM_REVIEW_ENABLED=false`, default) for a LightJev-only deploy. Local Bonsai / llama.cpp / vLLM:

```bash
LLM_REVIEW_ENABLED=true
LLM_REVIEW_ON_HIGH=true
LLM_REVIEW_API_URL=http://127.0.0.1:8081/v1
LLM_REVIEW_MODEL=Ternary-Bonsai-2-27B
```

## 第二輪覆核（灰帶／高分）

流程維持：**LightJev／現有 heuristic／本地分類／RAG** 先跑；**唔會為咗 LLM 拆走現有計分**。WhatsApp 仍然只係 archive，唔會 block 聯絡人。

- heuristic／RAG／外地號碼 hard archive → **立刻 archive，不呼叫 LLM**
- LightJev 高分 archive（分數/100 **高過** `LLM_REVIEW_GREY_MAX`，預設 0.85）→ **Bonsai/LLM 第二輪**（`LLM_REVIEW_ON_HIGH=true`，預設開）。LLM `not_scam` 可以 **放行** 分數誤報；`unknown`／失敗則 **維持 archive**
- 灰帶（預設分數/100 介乎 0.40–0.85）、LightJev 與本地規則衝突、短 OTP、未知號碼要錢 → **先規則遮罩 PII** → 再大模型覆核。灰帶原本未 archive 嘅，LLM 失敗仍然 fail-open（唔會單憑錯誤而 archive）
- 抑制改為意圖閘門：純防騙新聞／「小心」提醒不 archive；假冒「防騙」兼要驗證碼／轉帳仍會 archive

設定見 `.env.example`（`LLM_REVIEW_*`、`OPENAI_BASE_URL` / `OPENAI_API_KEY` 亦可）。可接雲端 API 或本地 Ollama／vLLM／Bonsai（`LLM_REVIEW_API_URL=http://127.0.0.1:8081/v1`）。

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
- `lib/llm-review.js` — optional OpenAI-compatible second pass (grey / conflict / high score; can release score FPs)
- `lib/scam-intent.js` — intent-gated suppress (warning vs OTP/money solicitation)
- `lightjev_serve.py` — persistent checkpoint worker (`POST /predict`)
- `stub-lightjev.js` — fixed probabilities for tests and local HTTP stub
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — kept / improved / deferred / rejected

## Disclaimer

This is a personal archive helper. WhatsApp Web automation can violate WhatsApp’s terms and may get the session logged out. Do not use it on other people’s accounts. Scores are **un-calibrated model probabilities** composed with hand-set weights — review every archive before you treat it as a scam.
