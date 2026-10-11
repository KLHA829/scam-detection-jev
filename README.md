# scam-detection-jev

Local **WhatsApp Web** bot that scores each 1:1 DM, **archives** risky chats, and **blocks** unsaved high-risk contacts.

**Primary (and only) scorer:** [jevlike](https://github.com/vinnylarouge/jevlike) with a frozen Hugging Face encoder `hfl/chinese-roberta-wwm-ext` and choice labels `not_scam` / `scam`. The fine-tuned head (`jevlike_hf_chinese_roberta_r1.pt`, ~2.3 MB) is already on GitHub Release tag [`jevlike-hf-r1`](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1); the encoder (~400 MB) downloads from the Hub on first run. This is the path meant for a **Raspberry Pi** and other CPU machines. There is **no** LightJev / `SCORER=model_v2` fallback.

**Blocking** is separate from archive. Unsaved contacts are blocked only when a tight scam regex hits on the current message. That hit is a solicit or an unsafe link, not a phrase such as 封號 or 轉數快 quoted from the news. A jevlike score, including one at or above `BLOCK_THRESHOLD` (default **80**), only archives. The reason is written onto the WhatsApp contact name (`封鎖·索取驗證碼`, …) and appended to `blocks.jsonl` (number, score, reason, time). Saved contacts are never auto-blocked. Grey scores and scorer failures do not block. It does **not** call Scameter or any phone/URL registry.

Eval note (does not block shipping): measured on a 366-message real HK set (179 scam / 187 innocent), the current head wrongly flags 18/187 innocents (9.6%) at the archive line and 10/187 (5.3%) at the block line; the older `hn800` head flagged 43/187 (23.0%) and 38/187 (20.3%) on the same set. 187 innocents is a small sample, so read those rates as a point estimate rather than a guarantee. Pi portability is the reason this deploy is jevlike-only.

## What it does

1. Reads 1:1 message bodies (including saved contacts).
2. **jevlike:** one forward pass over options `not_scam` / `scam`; `P(scam) × 100` is the 0–100 score.
3. **Archives** when the score is at or above the archive threshold, or when a tight regex heuristic fires.
4. **Blocks** an unsaved contact only when the current message's heuristic fired. Also mutes the chat. A high score stays archive-only. Saved contacts stay archive-only.
4. Optional OpenAI-compatible LLM second pass (default **off**). Grey/high unless `LLM_REVIEW_ALL=1`.

Filters drop `fromMe`, groups, notification types, your own account, and official WhatsApp names. `@lid` chats are resolved to a real number for logs and LLM context; LID digits are never used as a phone.

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
#    tag: jevlike-hf-r1
#    https://github.com/KLHA829/scam-detection-jev/releases/download/jevlike-hf-r1/jevlike_hf_chinese_roberta_r1.pt
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
- 權重已在 Release **`jevlike-hf-r1`**：https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1 。不要把 `.pt` / encoder 丟進 git history。
- 可選 LLM 覆核預設關閉（`LLM_REVIEW_ALL=0`、`LLM_REVIEW_ENABLED=false`）。

### Windows 注意

- **`npm test` 唔再寫死 `python3`。** Windows 冇 `python3` 呢個名，Windows venv 入面亦只有 `python.exe`，所以舊寫法喺 Windows 一定失敗（JS 部分跑完，Python 部分 command not found，npm exit 49）。而家由 `scripts/run-py-tests.js` 探測可用嘅 Python 3。
- **Chromium 唔會隨 `npm install` 下載。** npm 11 會擋 puppeteer 嘅 postinstall（`npm warn install-scripts`）。跑測試冇影響，但 `npm start` 掃 QR 之前要另外裝：
  ```bash
  npx puppeteer browsers install chrome
  ```
- **git-bash 底下 `scripts/download_jevlike_ckpt.sh` 改用相對路徑。** 原生 `gh.exe` 唔會翻譯 MSYS 路徑 —— 餵佢 `/c/Users/...` 佢會靜靜寫入 `C:\c\Users\...` 而 exit code 仍然係 0。腳本已改成 `cd "$DIR"` 加 `--dir .`。
- **唔好跑 `npm audit fix`** —— 詳見 [Known security advisories](#known-security-advisories)。

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
# Head checkpoint (~2.3 MB) is already on tag jevlike-hf-r1:
# https://github.com/KLHA829/scam-detection-jev/releases/download/jevlike-hf-r1/jevlike_hf_chinese_roberta_r1.pt
scripts/download_jevlike_ckpt.sh

# terminal 1 — first run downloads ~400 MB encoder weights
python jevlike_serve.py

# terminal 2
npm start
```

Scan the QR code. Session files stay in `.wwebjs_auth/` (gitignored).

Set `JEVLIKE_DEVICE=cuda` only if you have a compatible NVIDIA GPU. CPU is the Pi default.

### Windows notes

- `npm test` no longer hard-codes `python3`. Windows has no `python3` on PATH and a Windows venv ships only `python.exe`, so the old script always failed there (JS half passed, Python half died with exit 49). `scripts/run-py-tests.js` now probes for a working Python 3.
- Chromium is **not** downloaded by `npm install`: npm 11 blocks puppeteer's postinstall. Tests are unaffected; before `npm start`, install it explicitly:
  ```bash
  npx puppeteer browsers install chrome
  ```
- Under git-bash, `scripts/download_jevlike_ckpt.sh` now uses a relative `--dir`. The native `gh.exe` does not translate MSYS paths — given `/c/Users/...` it writes to `C:\c\Users\...` and still exits 0.
- **Do not run `npm audit fix`** — see [Known security advisories](#known-security-advisories).

### jevlike

| Variable | Default | Meaning |
|----------|---------|---------|
| `JEVLIKE_BASE_URL` | `http://127.0.0.1:8766` | Worker root. Client posts `{text}` to `{base}/v1/score`. |
| `JEVLIKE_API_KEY` | _(empty)_ | Optional Bearer token; must match the worker if set. |
| `JEVLIKE_TIMEOUT_MS` | `30000` | Per-attempt HTTP timeout. |
| `JEVLIKE_CKPT` | `models/jevlike_hf_chinese_roberta_r1.pt` | Fine-tuned head (current). Already published at `…/releases/download/jevlike-hf-r1/jevlike_hf_chinese_roberta_r1.pt`; the older baseline is on tag `jevlike-hf-hn800`. |
| `JEVLIKE_ENCODER` | `hfl/chinese-roberta-wwm-ext` | Frozen encoder id (Hub download, not git). |
| `JEVLIKE_DEVICE` | `cpu` | `cpu` or `cuda`. Worker only. |
| `JEVLIKE_OPTIONS` | `not_scam,scam` | Choice labels; `P(scam)` becomes the score. |

Offline scoring without weights:

```bash
npm run stub
# JEVLIKE_BASE_URL=http://127.0.0.1:8766 npm start
```

Include `[stub:scam]` in a message body to force the stub’s high-risk preset.

Keep `.wwebjs_auth/` across restarts. Deleting it forces a new QR login, which is a common way to get the session logged out. The only chats this bot messages are your own: setup, a review when you ask first, and a receipt after each archive or block. Block, rename, mute, and archive run one chat at a time, with `WA_ACTION_GAP_MS` between each call. The contact is saved only after the block succeeds.

### First-time choice

On the first ready session the bot sends a poll to your own WhatsApp chat:

- **自動封鎖同封存** — today's behaviour. After each archive or block, your own chat gets a receipt: the chat-list name, the phone, the score, and the local reason. A Cantonese note is requested only after `POST /v1/mask`, using `LLM_REVIEW_API_URL` / `LLM_REVIEW_MODEL`. It does not require `LLM_REVIEW_ENABLED`. The name and phone are attached on this machine and are not sent to the chat API. If masking or the model fails, the receipt still arrives and the model section says the explanation is unavailable.
- **逐條問我** — the same suspicion line, but nothing is archived or blocked until you choose. The original message is forwarded to you. A local note gives the score, the lure label, and whether the contact would have been blocked. A separate Cantonese explanation is requested only after `POST /v1/mask`. That call uses `LLM_REVIEW_API_URL` / `LLM_REVIEW_MODEL` and does not require `LLM_REVIEW_ENABLED`. If masking or the model fails, the poll still appears and the model section says the explanation is unavailable. The model cannot press a choice for you. After you pick **封鎖並封存** or **只封存**, the confirmation repeats the chat-list name, the phone, and the local reason. It does not call the model again.

Until you answer, suspicious chats are archived and nobody is blocked. `OPERATOR_MODE=auto` or `OPERATOR_MODE=guided` skips the question. Send `設定` in your own chat to choose again. Saved contacts are still never blocked unless you explicitly pick **封鎖並封存**. The first choice on a review poll is the one that runs.

### Scoring knobs (no code change)

See [SCORING_RUBRIC.md](SCORING_RUBRIC.md) and [scoring-rubric.json](scoring-rubric.json).

- `ARCHIVE_THRESHOLD` (default `42`) — label `scam` / archive from score
- `BLOCK_THRESHOLD` (default `80`) — still the line context review will not release. A score at this line archives and does **not** block. Heuristic hits block unsaved contacts.
- `BLOCK_ENABLED` (default `true`) — `false` restores archive-only
- `WA_ACTION_GAP_MS` (default `3000`) — minimum gap between WhatsApp account changes (block, rename, mute, archive). Chats are changed one at a time. Rename runs only after a successful block.
- `CONTEXT_TURNS` (default `4`) — score the current message, and also the last N inbound messages when that window scores higher. `1` disables the window.
- `CONTEXT_BENIGN_MIN_CHARS` (default `24`) — a longer message at or below `SAFE_THRESHOLD` keeps its own score
- `SAFE_THRESHOLD` (default `18`) — label `not_scam`
- `HEURISTIC_ENABLED` (default `true`)
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
- `CONTEXT_LLM_ENABLED` (default `false`) — replace the single-message second pass with a review of the latest inbound messages. The local worker returns PII-head spans (`POST /v1/mask`); the bot writes `XXX`, then asks the chat model for `archive` / `block` / `no_action`. A model `block` still has to pass the graded block gate. A missing head, a failed mask, or a bad model reply does not archive.
- `JEVLIKE_MASK_CKPT` — second jevlike head trained to mark personal-data characters (`python scripts/train_pii_mask.py`). It does not replace the scam scorer. Without it, `/v1/mask` returns 503 and the bot does not send the text. See [models/README.md](models/README.md).
- `CONTEXT_LLM_MESSAGES` (default `10`, capped at 10) — how many of the latest inbound messages are sent. The message that just arrived is always included.

If the scorer times out, returns 5xx, or sends invalid JSON, the label is **`unknown`**. Unknown **does not archive** unless a heuristic (or optional RAG / local classifier) fires.

## Second-pass review (grey / conflict / high / optional all)

Primary scoring is unchanged. After it, obvious heuristics, and optional local/RAG matchers, a **second pass** can run when `LLM_REVIEW_ENABLED=true` **or** `LLM_REVIEW_ALL=1`:

1. **Non-score hard archive** (`obvious_scam`, `rag_scam_match`, `local_classifier`) → archive immediately. No LLM. Heuristic/RAG hits also skip the LLM even if the scorer already chose `jevlike_score`.
2. **Self-OTP suppress** — a message that is itself an OTP delivery (`您的驗證碼是 …` / `don't share this code`) is **not** archived when it does not also solicit. Words such as `防騙` / `小心` / `新聞` do not suppress a score. Fake 「我係防騙協調中心…請提供密碼/轉帳」 is **not** suppressed, because it solicits OTP, money, or impersonation+secrecy. A heuristic, RAG, or local-classifier hit is **not** suppressed.
3. **When `LLM_REVIEW_ALL=0` (default):** grey / conflict / high → mask → LLM:
   - score in grey band `LLM_REVIEW_GREY_MIN`–`LLM_REVIEW_GREY_MAX` (defaults **0.40–0.85**, score/100)
   - high primary score when `LLM_REVIEW_ON_HIGH=true` (default): **score/100 > `LLM_REVIEW_GREY_MAX`**
   - scorer vs local/heuristic conflict (including money/OTP solicitation vs a `not_scam` label)
   - short OTP-ish message (`LLM_REVIEW_OTP_MAX_CHARS`, default 96)
   - money ask from an unsaved / new number
4. **When `LLM_REVIEW_ALL=1`:** every remaining message after the scorer goes to the LLM (same mask + merge). Hard archives and a suppressed self-OTP delivery still skip.
5. Desensitisation is the jevlike PII head (`POST /v1/mask`). The bot replaces those character spans with `XXX`. The span list stays local and is **never** sent. If the head is not loaded, the LLM call is skipped.
6. OpenAI-compatible `POST …/v1/chat/completions` (`lib/llm-review.js`) must return JSON `{ label, confidence, signals, should_archive, reason }`.

### Merge policy (LLM vs jevlike)

`LLM_REVIEW_MERGE=bonsai` (default, same FP-aware Bonsai merge as before):

| LLM | Primary | Result |
|-----|---------|--------|
| `scam` / `should_archive` | anything except hard-skip (already skipped) | archive `llm_review_scam` |
| `not_scam` | score-only archive (`jevlike_score`) | **release** to ignore |
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

# Optional: review every DM after jevlike (still mask with the PII head)
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

流程維持：**jevlike／heuristic／本地分類／RAG** 先跑；**唔會為咗 LLM 拆走現有計分**。已儲存聯絡人只會 archive。未儲存聯絡人先會 block：當前句係索取或者危險連結，而唔係新聞引述嘅封號／轉數快字眼。分數達到 `BLOCK_THRESHOLD`（預設 80）只會封存，唔會封鎖。封鎖原因會寫入 WhatsApp 聯絡人名（`封鎖·…`），並追加到 `blocks.jsonl`。灰帶同分數失敗唔會 block。LLM 若把高分放行，就唔會 block。對外 LLM 之前用 jevlike 脱敏頭把個人資料換成 `XXX`；頭未載入就唔送。假冒兼索取驗證碼、轉帳，或者假冒加保密，仍然封鎖。

- heuristic／RAG hard archive → **立刻 archive，不呼叫 LLM**（`LLM_REVIEW_ALL=1` 都一樣）
- 主模型高分 archive（分數/100 **高過** `LLM_REVIEW_GREY_MAX`，預設 0.85）→ **LLM 第二輪**（`LLM_REVIEW_ON_HIGH=true`，預設開）。LLM `not_scam` 可以 **放行** 分數誤報；`unknown`／失敗則 **維持 archive**
- 灰帶（預設分數/100 介乎 0.40–0.85）、與本地規則衝突、短 OTP、未知號碼要錢 → 大模型覆核。灰帶原本未 archive 嘅，LLM 失敗仍然 fail-open
- `LLM_REVIEW_ALL=1`（預設 `0`）→ 計分之後 **每一則** 剩餘訊息都送 LLM。合併策略預設 `bonsai`（LLM 講 scam 就 archive；LLM 講 not_scam 可以放行分數 archive）
- 抑制只覆蓋「驗證碼就係呢則訊息」嘅自我 OTP。`防騙`／`小心`／`新聞` 唔會壓過分數。假冒「防騙」兼要驗證碼／轉帳仍會 archive

第二輪係 **任何 OpenAI-compatible Chat Completions API**。詳見 `.env.example`。

## Tests

`npm test` is **offline**: in-process stub probabilities, no live WhatsApp, no encoder download. GitHub Actions runs it on every pull request and on pushes to `main`.

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

- `whatsapp-bot.js` — WhatsApp Web client, QR, archive and graded block, self-chat setup poll
- `lib/operator-mode.js` — `auto` or `guided`, stored in `operator-mode.json`
- `lib/review-guide.js` — masked Cantonese explanation for guided review
- `lib/scorer.js` — always builds a jevlike client (`createScoreClient`)
- `lib/jevlike-client.js` — `{text}` → `{prob_scam}`
- `lib/mask-spans.js` — offline stand-in for the PII head (`POST /v1/mask` on the worker is the live path)
- `lib/llm-review.js` — optional OpenAI-compatible second pass
- `lib/scam-intent.js` — solicit detectors and self-OTP suppress
- `jevlike_serve.py` — persistent HF-encoder jevlike worker (`POST /v1/score`)
- `stub-jevlike.js` — fixed probabilities for tests
- `models/README.md` — GitHub Release download for the `.pt` head
- `scripts/download_jevlike_ckpt.sh` — pulls `jevlike-hf-r1` via `/releases/download/…/jevlike_hf_chinese_roberta_r1.pt`
- `scripts/run-py-tests.js` — portable Python 3 launcher for the unittest half of `npm test`
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — kept / improved / deferred / rejected

## Known security advisories

`npm audit` reports **5 high** findings. All five trace to a single root: `extract-zip`, pulled in through `@puppeteer/browsers` ← `puppeteer` ← `whatsapp-web.js`. Nothing in this repo's own code is implicated.

- [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) — unvalidated symlink path traversal. [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) — arbitrary file writes through symlink archive entries.
- `extract-zip`'s vulnerable range is `*` — **every released version is affected, including the current 2.0.1**. There is no patched upstream release, so there is nothing to upgrade to.
- Practical exposure is low. `extract-zip` runs only while Puppeteer unpacks the Chrome-for-Testing archive it downloads from Google's CDN. It is not on the path that processes WhatsApp messages, and exploiting it requires control of that archive (CDN compromise or MITM).
- `npm audit` reports `fixAvailable: true`, which is misleading: it means "remove this dependency", and the only way it can do that is to **downgrade puppeteer to 18.2.1**. A `--dry-run` shows it would also take `zip-stream` 6.0.1 → 4.1.1, re-add the legacy `@pedroslopez/moduleraid` 5.0.2, and remove `yargs` / `zod`. `whatsapp-web.js@1.34.7` pins `puppeteer` at exactly `24.38.0`, so that downgrade breaks the bot.

**Do not run `npm audit fix`.** The finding is accepted as a known issue with no available fix.

## Disclaimer

This is a personal filter. WhatsApp Web automation can violate WhatsApp’s terms and may get the session logged out. Do not use it on other people’s accounts. Scores are **un-calibrated model probabilities**. Saved contacts are not auto-blocked; unsaved blocks still need a look at `blocks.jsonl` before you treat the name as final.
