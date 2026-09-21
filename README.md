# scam-detection-jev

Local **WhatsApp Web** bot that scores each 1:1 DM and **archives** high-risk chats.

**Default primary scorer:** [jevlike](https://github.com/vinnylarouge/jevlike) with a frozen Hugging Face encoder `hfl/chinese-roberta-wwm-ext` and choice labels `not_scam` / `scam`. The fine-tuned head (`jevlike_hf_chinese_roberta_hn800.pt`, ~2.3 MB) is already on GitHub Release tag [`jevlike-hf-hn800`](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-hn800); the encoder (~400 MB) downloads from the Hub on first run. This is the path meant for a **Raspberry Pi** and other CPU machines.

**Fallback:** `SCORER=model_v2` (alias `lightjev`) keeps the previous **LightJev** 0.6B multi-label rubric worker. Do not use that as the Pi default (~2.4 GB weights).

It does **not** block contacts from the score. It does **not** call Scameter or any phone/URL registry.

Eval note (does not block shipping): hn800 beats a local `model_v2` RoBERTa baseline on friend/family FPR (0% vs 10%) and trails on hk50 Acc (0.88 vs 0.96). Pi portability is the reason jevlike is primary.

## What it does

1. Reads 1:1 message bodies (including saved contacts).
2. **jevlike (default):** one forward pass over options `not_scam` / `scam`; `P(scam) × 100` is the 0–100 score.
3. **model_v2:** maps each rubric dimension to a LightJev boolean record; aggregates `P(true)` into one 0–100 score.
4. **Archives** when the score is at or above the archive threshold, when a tight regex heuristic fires, or when an **unsaved non-local** number messages you (HK `852` / CN `86` / TW `886` are local; `880–883` and `888` are not treated as China).
5. Optional startup pass: first **10** sidebar 1:1 chats, **foreign-number archive only** (no scoring).
6. Optional OpenAI-compatible LLM second pass (default **off**). Grey/high unless `LLM_REVIEW_ALL=1`.

Filters drop `fromMe`, groups, notification types, your own account, and official WhatsApp names. `@lid` chats are resolved to a real number before the foreign-number rule; LID digits are never used as a phone.

## Raspberry Pi / 其他機器安裝（正體中文）

需要 **Node.js 20+**、**Python 3.11+**（3.10 也通，但建議 3.11）、64-bit OS（Pi 用 Raspberry Pi OS 64-bit / aarch64）。

```bash
git clone git@github.com:KLHA829/scam-detection-jev.git
cd scam-detection-jev
cp .env.example .env

python3.11 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# 1) 先裝 CPU 版 PyTorch（Pi aarch64 或 x86 沒有 CUDA 時）
python -m pip install --upgrade pip
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu

# 2) jevlike + transformers（不要把 HF encoder 推進 git）
python -m pip install -r requirements.txt

npm install

# 3) 從已發布的 GitHub Release 拉 ~2.3 MB 的微調頭（不用再等上傳）
#    tag: jevlike-hf-hn800
#    https://github.com/KLHA829/scam-detection-jev/releases/download/jevlike-hf-hn800/jevlike_hf_chinese_roberta_hn800.pt
#    私有 repo 需要 gh 已登入，或 GH_TOKEN / GITHUB_TOKEN
scripts/download_jevlike_ckpt.sh

# terminal 1 — 第一次會從 Hugging Face 下載
# hfl/chinese-roberta-wwm-ext（約 400 MB，Pi 上可能要數分鐘）
python jevlike_serve.py

# terminal 2
npm start
```

掃 QR。Session 在 `.wwebjs_auth/`（已 gitignore）。

**注意：**

- 編碼器不在 git。第一次啟動有下載體積與延遲；cache 通常在 `~/.cache/huggingface/`。
- Pi 記憶體建議 4 GB+。`JEVLIKE_DEVICE=cpu` 為預設。
- 權重已在 Release **`jevlike-hf-hn800`**：https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-hn800 。不要把 `.pt` / encoder 丟進 git history。
- 可選 LLM 覆核預設關閉（`LLM_REVIEW_ALL=0`、`LLM_REVIEW_ENABLED=false`）。

詳細見 [models/README.md](models/README.md)。

## Setup (English)

Requires **Node.js 20+**, **Python 3.11+**, and a WhatsApp account you are allowed to link via WhatsApp Web.

```bash
cp .env.example .env
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt
npm install
# Head checkpoint (~2.3 MB) is already on tag jevlike-hf-hn800:
# https://github.com/KLHA829/scam-detection-jev/releases/download/jevlike-hf-hn800/jevlike_hf_chinese_roberta_hn800.pt
scripts/download_jevlike_ckpt.sh

# terminal 1 — first run downloads ~400 MB encoder weights
python jevlike_serve.py

# terminal 2
npm start
```

Scan the QR code. Session files stay in `.wwebjs_auth/` (gitignored).

Set `JEVLIKE_DEVICE=cuda` only if you have a compatible NVIDIA GPU. CPU is the Pi default.

### Scorer selection

| `SCORER` | Meaning |
|----------|---------|
| `jevlike` (default) | HF-encoder jevlike worker (`python jevlike_serve.py`) |
| `model_v2` or `lightjev` | Previous LightJev 0.6B rubric worker (`python lightjev_serve.py`) |

### jevlike

| Variable | Default | Meaning |
|----------|---------|---------|
| `JEVLIKE_BASE_URL` | `http://127.0.0.1:8766` | Worker root. Client posts `{text}` to `{base}/v1/score`. |
| `JEVLIKE_API_KEY` | _(empty)_ | Optional Bearer token; must match the worker if set. |
| `JEVLIKE_TIMEOUT_MS` | `30000` | Per-attempt HTTP timeout. |
| `JEVLIKE_CKPT` | `models/jevlike_hf_chinese_roberta.pt` | Fine-tuned head. Already published at `…/releases/download/jevlike-hf-hn800/jevlike_hf_chinese_roberta_hn800.pt`. |
| `JEVLIKE_ENCODER` | `hfl/chinese-roberta-wwm-ext` | Frozen encoder id (Hub download, not git). |
| `JEVLIKE_DEVICE` | `cpu` | `cpu` or `cuda`. Worker only. |
| `JEVLIKE_OPTIONS` | `not_scam,scam` | Choice labels; `P(scam)` becomes the score. |

Offline scoring without weights:

```bash
npm run stub:jevlike
# JEVLIKE_BASE_URL=http://127.0.0.1:8766 npm start
```

Include `[stub:scam]` in a message body to force the stub’s high-risk preset.

### model_v2 / LightJev fallback

```bash
python -m pip install -r requirements-lightjev.txt
# terminal 1 — loads ~2.4 GB of LightJev-0.6B weights on first run
python lightjev_serve.py
# .env: SCORER=model_v2
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `LIGHTJEV_BASE_URL` | `http://127.0.0.1:8765` | Worker root. Client posts `{records}` to `{base}/predict`. |
| `LIGHTJEV_CHECKPOINT` | `rongxinzy/LightJev-0.6B-v0.1` | Hub id or local folder with `manifest.json`. |
| `LIGHTJEV_DEVICE` | `cpu` | `cpu` or `cuda`. |

For an HTTP stub of LightJev: `npm run stub`.

### Scoring knobs (no code change)

See [SCORING_RUBRIC.md](SCORING_RUBRIC.md) and [scoring-rubric.json](scoring-rubric.json).

- `ARCHIVE_THRESHOLD` (default `42`) — label `scam` / archive from score
- `SAFE_THRESHOLD` (default `18`) — label `not_scam`
- `HEURISTIC_ENABLED` (default `true`)
- `STARTUP_FOREIGN_SCAN` (default `true`)
- `SCORE_CACHE_TTL_MS` (default `900000`)
- `RUBRIC_PATH` — override JSON path
- `LLM_REVIEW_ENABLED` (default `false`)
- `LLM_REVIEW_ALL` (default `0`) — `1` sends **every** remaining message to the LLM after the scorer
- `LLM_REVIEW_MERGE` (default `bonsai`) — disagreement policy (see below)
- `LLM_REVIEW_ON_HIGH` (default `true` — used only when LLM review is enabled and `LLM_REVIEW_ALL=0`)
- `LLM_REVIEW_GREY_MIN` / `LLM_REVIEW_GREY_MAX` (defaults `0.40` / `0.85`, score/100)
- `LLM_REVIEW_OTP_MAX_CHARS` (default `96`)
- `LLM_REVIEW_API_URL` or `OPENAI_BASE_URL` / `OPENAI_API_BASE` — any OpenAI-compatible Chat Completions base
- `LLM_REVIEW_API_KEY` or `OPENAI_API_KEY` — **optional**; omit for local servers with no auth; when set, sent as `Authorization: Bearer …`
- `LLM_REVIEW_MODEL` (default `gpt-4o-mini`; use the model id your server expects)
- `LLM_REVIEW_TIMEOUT_MS` (default `8000`)

If the primary scorer times out, returns 5xx, or sends invalid JSON, the label is **`unknown`**. Unknown **does not archive** unless the foreign-number rule or heuristic fires.

## Second-pass review (grey / conflict / high / optional all)

Primary scoring is unchanged. After it, obvious heuristics, optional local/RAG matchers, and the foreign-number rule, a **second pass** can run when `LLM_REVIEW_ENABLED=true` **or** `LLM_REVIEW_ALL=1`:

1. **Non-score hard archive** (`obvious_scam`, `rag_scam_match`, `local_classifier`, `foreign_number`) → archive immediately. No LLM. Heuristic/RAG hits also skip the LLM even if the scorer already chose `jevlike_score` / `lightjev_score`.
2. **Intent-gated suppress** — copy that only warns (`防騙` / `小心` / `新聞` / self-OTP) is **not** archived. Fake 「我係防騙協調中心…請提供密碼/轉帳」 is **not** suppressed, because it also solicits OTP, money, or impersonation+secrecy.
3. **When `LLM_REVIEW_ALL=0` (default):** grey / conflict / high → redact → LLM:
   - score in grey band `LLM_REVIEW_GREY_MIN`–`LLM_REVIEW_GREY_MAX` (defaults **0.40–0.85**, score/100)
   - high primary score when `LLM_REVIEW_ON_HIGH=true` (default): **score/100 > `LLM_REVIEW_GREY_MAX`**
   - scorer vs local/heuristic conflict (including money/OTP solicitation vs a `not_scam` label)
   - short OTP-ish message (`LLM_REVIEW_OTP_MAX_CHARS`, default 96)
   - money ask from an unsaved / new / non-local number
4. **When `LLM_REVIEW_ALL=1`:** every remaining message after the scorer goes to the LLM (same redaction + merge). Hard archives and suppressed warnings still skip.
5. Rule-based PII redaction (`lib/redact.js`, **no LLM**) replaces HK phones `[電話]`, bank/FPS/PayMe `[戶口]`, emails `[電郵]`, ID-like `[證件]`, easy names `[姓名]`, and strips URL paths to the domain. A local mapping may be kept in memory for logs; it is **never** sent to the LLM.
6. OpenAI-compatible `POST …/v1/chat/completions` (`lib/llm-review.js`) must return JSON `{ label, confidence, signals, should_archive, reason }`.

### Merge policy (LLM vs jevlike / model_v2)

`LLM_REVIEW_MERGE=bonsai` (default, same FP-aware Bonsai merge as before):

| LLM | Primary | Result |
|-----|---------|--------|
| `scam` / `should_archive` | anything except hard-skip (already skipped) | archive `llm_review_scam` |
| `not_scam` | score-only archive (`jevlike_score` / `lightjev_score`) | **release** to ignore |
| `not_scam` | ignore | stay ignore |
| `unknown` / timeout / 5xx | score archive | **keep** archive (fail toward scam on high) |
| `unknown` / timeout / 5xx | ignore (grey, not already archived) | stay ignore (fail-open) |

`LLM_REVIEW_MERGE=archive_only`: LLM may add archives but **never** release a score archive.

Disable the LLM (`LLM_REVIEW_ENABLED=false` and `LLM_REVIEW_ALL=0`, both default) for a scorer-only deploy.

The second pass is **any OpenAI-compatible Chat Completions API**. The same variables work for OpenAI cloud, Ollama, vLLM, or llama.cpp `llama-server`. `LLM_REVIEW_API_KEY` is optional.

```bash
# OpenAI cloud
LLM_REVIEW_ENABLED=true
LLM_REVIEW_API_URL=https://api.openai.com/v1
LLM_REVIEW_API_KEY=sk-...
LLM_REVIEW_MODEL=gpt-4o-mini

# Optional: review every DM after jevlike (still redact PII)
# LLM_REVIEW_ALL=1

# Ollama
# LLM_REVIEW_API_URL=http://127.0.0.1:11434/v1
# LLM_REVIEW_MODEL=llama3
# LLM_REVIEW_API_KEY=

# llama.cpp llama-server (example: Ternary-Bonsai)
# LLM_REVIEW_API_URL=http://127.0.0.1:8081/v1
# LLM_REVIEW_MODEL=Ternary-Bonsai-2-27B
# LLM_REVIEW_API_KEY=local    # or empty if the server has no --api-key
```

Aliases if `LLM_REVIEW_API_URL` / `LLM_REVIEW_API_KEY` are unset: `OPENAI_BASE_URL` / `OPENAI_API_BASE` and `OPENAI_API_KEY`.

## 第二輪覆核（灰帶／高分／可選全部）

流程維持：**jevlike 或 model_v2／heuristic／本地分類／RAG** 先跑；**唔會為咗 LLM 拆走現有計分**。WhatsApp 仍然只係 archive，唔會 block 聯絡人。PII 一律先規則遮罩。

- heuristic／RAG／外地號碼 hard archive → **立刻 archive，不呼叫 LLM**（`LLM_REVIEW_ALL=1` 都一樣）
- 主模型高分 archive（分數/100 **高過** `LLM_REVIEW_GREY_MAX`，預設 0.85）→ **LLM 第二輪**（`LLM_REVIEW_ON_HIGH=true`，預設開）。LLM `not_scam` 可以 **放行** 分數誤報；`unknown`／失敗則 **維持 archive**
- 灰帶（預設分數/100 介乎 0.40–0.85）、與本地規則衝突、短 OTP、未知號碼要錢 → 大模型覆核。灰帶原本未 archive 嘅，LLM 失敗仍然 fail-open
- `LLM_REVIEW_ALL=1`（預設 `0`）→ 計分之後 **每一則** 剩餘訊息都送 LLM。合併策略預設 `bonsai`（LLM 講 scam 就 archive；LLM 講 not_scam 可以放行分數 archive）
- 抑制改為意圖閘門：純防騙新聞／「小心」提醒不 archive；假冒「防騙」兼要驗證碼／轉帳仍會 archive

第二輪係 **任何 OpenAI-compatible Chat Completions API**。詳見 `.env.example`。

## Tests

`npm test` is **offline**: in-process stub probabilities, no live WhatsApp, no encoder download.

```bash
npm test
```

## Docker (optional)

The Node image runs WhatsApp Web (Chromium) only. Run jevlike as a sibling process and point `JEVLIKE_BASE_URL` at it.

```bash
docker build -t scam-detection-jev .
docker run --rm -it \
  -e JEVLIKE_BASE_URL=http://host.docker.internal:8766 \
  -v "$(pwd)/.wwebjs_auth:/app/.wwebjs_auth" \
  scam-detection-jev
```

QR login still needs a terminal that can show the code (or inspect container logs).

## Layout

- `whatsapp-bot.js` — WhatsApp Web client, QR, archive-only actions
- `lib/scorer.js` — `SCORER=jevlike` (default) vs `model_v2`
- `lib/jevlike-client.js` — `{text}` → `{prob_scam}`
- `lib/lightjev-client.js` — noul questions → LightJev boolean records (`SCORER=model_v2`)
- `lib/redact.js` — rule-based PII redaction before any external LLM call
- `lib/llm-review.js` — optional OpenAI-compatible second pass
- `lib/scam-intent.js` — intent-gated suppress (warning vs OTP/money solicitation)
- `jevlike_serve.py` — persistent HF-encoder jevlike worker (`POST /v1/score`)
- `lightjev_serve.py` — LightJev 0.6B worker (`POST /predict`)
- `stub-jevlike.js` / `stub-lightjev.js` — fixed probabilities for tests
- `models/README.md` — GitHub Release download for the `.pt` head
- `scripts/download_jevlike_ckpt.sh` — pulls `jevlike-hf-hn800` via `/releases/download/…/jevlike_hf_chinese_roberta_hn800.pt`
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — kept / improved / deferred / rejected

## Disclaimer

This is a personal archive helper. WhatsApp Web automation can violate WhatsApp’s terms and may get the session logged out. Do not use it on other people’s accounts. Scores are **un-calibrated model probabilities** — review every archive before you treat it as a scam.
