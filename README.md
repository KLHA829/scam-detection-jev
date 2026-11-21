# scam-detection-jev

Personal **WhatsApp Web** bot: it masks PII on your machine, sends redacted text to an **OpenAI-compatible** chat API, archives suspicious 1:1 DMs, and blocks **unsaved** contacts only when a URL matches [`data/malicious-hosts.json`](data/malicious-hosts.json).

Local [jevlike](https://github.com/vinnylarouge/jevlike) serves **`POST /v1/mask`**. Judgment uses **`LLM_REVIEW_*`**. The frozen scam head (`jevlike_hf_chinese_roberta_r1.pt`) is for **lab eval** only. There is no LightJev or `SCORER=model_v2` path.

For why the live path works this way, see [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md). For thresholds and decision labels, see [SCORING_RUBRIC.md](SCORING_RUBRIC.md).

## Before you start

You need **Node.js 20+**, **Python 3.11+** (3.10 works; 3.11 is preferred), a WhatsApp account you may link via WhatsApp Web, and an OpenAI-compatible API for `LLM_REVIEW_*`.

Copy [`.env.example`](.env.example) to `.env`. Product invariants live in [AGENTS.md](AGENTS.md). Do not run `npm audit fix` (it downgrades Puppeteer and breaks the bot). See [Known security advisories](#known-security-advisories).

On Windows, install Chromium before `npm start`:

```bash
npx puppeteer browsers install chrome
```

`npm test` does not need Chromium. It uses `scripts/run-py-tests.js` to find Python 3 (Windows has no `python3` on PATH).

## Run the worker and the bot

```bash
cp .env.example .env
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt
npm install
scripts/download_jevlike_ckpt.sh
python scripts/train_pii_mask.py --output models/jevlike_hf_pii_mask.pt

# Terminal 1 — activate the venv; training downloads the encoder once (~400 MB)
python jevlike_serve.py

# Terminal 2 — verify before starting the bot
curl -s localhost:8766/health
# Must include "pii_mask": true ("ok": true alone is not enough)
curl -s -X POST localhost:8766/v1/mask -H 'content-type: application/json' -d '{"messages":["我叫陳大文，電話 91234567"]}'
# Must return spans, not a 503 error
npm start
```

Scan the QR code. Session data stays in `.wwebjs_auth/` (gitignored). Keep that folder across restarts. Deleting it forces a new login and often logs the session out.

Set `JEVLIKE_DEVICE=cuda` only when you have a compatible NVIDIA GPU. CPU is the default on a Pi.

The r1 download alone cannot serve `/v1/mask`: training creates the separate PII head (see [models/README.md](models/README.md)). Alternatively, export `JEVLIKE_MASK_CKPT=/path/to/jevlike_hf_pii_mask.pt` for an existing trained head in the worker shell. `jevlike_serve.py` does not read `.env`; export optional lab `JEVLIKE_CKPT` there too. Restart the worker after training or changing the head. Without it, `/v1/mask` returns 503 and the bot skips the LLM.

### Raspberry Pi (正體中文)

需要 **Node.js 20+**、**Python 3.11+**、64-bit OS（Raspberry Pi OS 64-bit / aarch64）。

```bash
git clone git@github.com:KLHA829/scam-detection-jev.git
cd scam-detection-jev
cp .env.example .env

python3.11 -m venv .venv
source .venv/bin/activate

python -m pip install --upgrade pip
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt
npm install
scripts/download_jevlike_ckpt.sh
python scripts/train_pii_mask.py --output models/jevlike_hf_pii_mask.pt

python jevlike_serve.py   # terminal 1

# terminal 2：先確認脫敏頭已載入，再啟動 bot
curl -s localhost:8766/health
# 必須包含 "pii_mask": true；只有 "ok": true 並不足夠
curl -s -X POST localhost:8766/v1/mask -H 'content-type: application/json' -d '{"messages":["我叫陳大文，電話 91234567"]}'
# 應回傳 spans，不能是 503 錯誤
npm start                 # terminal 2
```

掃 QR。Session 在 `.wwebjs_auth/`。權重見 Release [jevlike-hf-r1](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1)。不要把 `.pt` 或 encoder 推進 git。詳見 [models/README.md](models/README.md)。

Pi 建議 4 GB RAM 以上。`JEVLIKE_DEVICE=cpu` 為預設。

只下載 r1 並不會產生脫敏頭；上面的訓練會另存 `models/jevlike_hf_pii_mask.pt`，不會覆蓋 r1。首次訓練會下載約 400 MB 編碼器，Pi 上 CPU 訓練可能需較長時間。亦可在其他機器訓練後複製頭檔，並在啟動 worker 的 shell 執行 `export JEVLIKE_MASK_CKPT=/path/to/jevlike_hf_pii_mask.pt`。Worker 不會讀取 `.env`；訓練或換頭後須重新啟動，再檢查上述兩個端點。缺少脫敏頭時 `/v1/mask` 會回 503，bot 會跳過 LLM。

### Windows notes

- `scripts/download_jevlike_ckpt.sh` under git-bash uses a relative `--dir` so native `gh.exe` does not write to `C:\c\Users\...`.
- Do not run `npm audit fix`. See [Known security advisories](#known-security-advisories).

## Point the bot at your API

Set `LLM_REVIEW_API_URL`, `LLM_REVIEW_MODEL`, and `LLM_REVIEW_API_KEY` when your server needs auth. `LLM_REVIEW_ENABLED` defaults to **true**.

Live inbound order (after filters): link heuristics on the current message, then mask and LLM. **`CONTEXT_LLM_ENABLED` defaults to on** (masked transcript of recent inbound messages). Set `CONTEXT_LLM_ENABLED=0` or `false` for single-message primary LLM only.

If `POST /v1/mask` fails, the bot skips the LLM and does not archive (fail closed). Link-rule archives still run without the LLM.

Full flag list: [`.env.example`](.env.example) and [AGENTS.md](AGENTS.md). Behaviour matrix: [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented). Lab-only jevlike thresholds: [SCORING_RUBRIC.md](SCORING_RUBRIC.md).

### Runtime settings

The bot loads `.env`. Export worker and download-helper settings in their starting
shells: neither reads `.env`. Defaults below are code defaults when unset, not
necessarily the example values in `.env.example`. Relative bot state paths are
relative to the working directory; worker checkpoint defaults are repo-relative.

| Setting | Default | Meaning |
|---|---|---|
| `JEVLIKE_BASE_URL` | `http://127.0.0.1:8766` | Bot's local worker URL. |
| `JEVLIKE_API_KEY` | Empty | Worker bearer auth; set the same key on bot and worker. Empty disables worker auth. |
| `JEVLIKE_TIMEOUT_MS` | `30000` | Bot's worker request timeout in ms. |
| `JEVLIKE_HOST`, `JEVLIKE_PORT` | `127.0.0.1`, `8766` | Worker bind address and port (stub also reads the port). Avoid an open bind without auth. |
| `JEVLIKE_MAX_BODY` | `65536` | Maximum worker HTTP body bytes; larger requests return 413. |
| `JEVLIKE_DEVICE` | `cpu` | Worker device; unavailable CUDA falls back to CPU. |
| `JEVLIKE_CKPT`, `JEVLIKE_CHECKPOINT` | `models/jevlike_hf_chinese_roberta_r1.pt` | Scorer/encoder checkpoint; first nonempty setting wins, then the default file. Missing file is an error. Scoring is lab-only. |
| `JEVLIKE_ENCODER`, `JEVLIKE_HF_MODEL` | Checkpoint `hf_model`, then `hfl/chinese-roberta-wwm-ext` | Encoder overrides, in that precedence order. |
| `JEVLIKE_OPTIONS` | `not_scam,scam` | Scorer labels (lab); requires at least two. |
| `JEVLIKE_MASK_CKPT` | `models/jevlike_hf_pii_mask.pt` if present | PII head. A missing configured file logs a warning and the worker still starts without the head; `/v1/mask` returns 503 until a head is loaded. |
| `HEURISTIC_ENABLED` | `true` | Enables link-rule hard archives. |
| `BLOCK_ENABLED` | `true` | Enables malicious-host auto-block of unsaved contacts, not model-based blocking. |
| `MALICIOUS_HOSTS_PATH` | `data/malicious-hosts.json` in the repo | Maintained host list override. |
| `MALICIOUS_HOSTS_ALLOW_EMPTY` | Off | Set `1` or `true` to allow a reload with `hosts:[]` to clear the in-memory list. |
| `BLOCK_LOG_PATH` | `./blocks.jsonl` | Local block history used by operator commands. |
| `OPERATOR_MODE` | Unset | `auto` or `guided` pins mode; otherwise use saved choice or ask on first run. |
| `OPERATOR_MODE_PATH`, `REVIEW_QUEUE_PATH` | `./operator-mode.json`, `./review-queue.json` | Saved operator mode and guided review queue. |
| `WA_ACTION_GAP_MS` | `3000` | Gap between queued WhatsApp writes in ms. |
| `CONTEXT_TURNS` | `4` | In-memory thread window capacity including current text; not a live scoring window. |
| `CONTEXT_LLM_ENABLED` | On | Use masked recent-message review; `0` or `false` selects single-message review. |
| `CONTEXT_LLM_MESSAGES` | `10` | Recent inbound message limit including current message; capped at 10. Invalid values or values below 1 use the default. |
| `LLM_REVIEW_ENABLED` | `true` | Enable LLM judgment; disabling it leaves only heuristic archives. |
| `LLM_REVIEW_ALL` | `false` | Legacy eval override that also forces LLM review enabled, even if `LLM_REVIEW_ENABLED=false`. |
| `LLM_REVIEW_API_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` | Empty | First nonempty URL wins, in this order. No implicit OpenAI endpoint; without a URL, review fails closed. Accepts a base URL or full `/chat/completions` URL. |
| `LLM_REVIEW_API_KEY`, `OPENAI_API_KEY` | Empty | First nonempty key wins; empty omits the authorization header. |
| `LLM_REVIEW_MODEL` | `gpt-4o-mini` | Chat model name. |
| `LLM_REVIEW_TIMEOUT_MS` | `8000` | Chat request timeout in ms. |
| `LLM_REVIEW_MIN_CONFIDENCE` | `0.7` | Minimum confidence for primary or context review to archive. |
| `LLM_REVIEW_COOLDOWN_MS` | `600000` | Per-chat cooldown in ms after successful automatic archive or guided archive recommendation; nonpositive disables it. |
| `LLM_REVIEW_COOLDOWN_PATH` | `./llm-review-cooldown.json` | Persist cooldown across restarts. Save failure keeps it in memory only. |
| `RUBRIC_PATH` | Repo `scoring-rubric.json` | Rubric file override; jevlike score thresholds are lab-only, not live archive decisions. |
| `PUPPETEER_EXECUTABLE_PATH` | Unset | Override Puppeteer's browser executable. |
| `PUPPETEER_NO_SANDBOX` | Unset | Exactly `1` disables Chromium sandboxing. Root already disables it; do not opt in unless required. |
| `PUPPETEER_SKIP_DOWNLOAD` | Unset | Puppeteer installation option to skip browser download, not a bot behavior flag. |

### Checkpoint download helper settings

These are user-facing setup options for `scripts/download_jevlike_ckpt.sh`.

| Setting | Default | Meaning |
|---|---|---|
| `JEVLIKE_RELEASE_REPO` | `KLHA829/scam-detection-jev` | GitHub release repository. |
| `JEVLIKE_RELEASE_TAG` | `jevlike-hf-r1` | Release tag. |
| `JEVLIKE_RELEASE_ASSET` | `jevlike_hf_chinese_roberta_r1.pt` | Asset filename. |
| `JEVLIKE_DOWNLOAD_URL` | `https://github.com/{repo}/releases/download/{tag}/{asset}` | Direct download URL built from the settings above. |
| `JEVLIKE_CKPT` | Repo `models/jevlike_hf_chinese_roberta.pt` | Helper destination (different from the worker's r1 default); the named asset is also kept beside it. |
| `JEVLIKE_CKPT_MIN_BYTES` | `1000000` | Minimum size accepted as a checkpoint. |
| `JEVLIKE_CKPT_FORCE` | `0` | Exactly `1` bypasses the existing-destination shortcut and downloads again. |
| `GH_TOKEN`, `GITHUB_TOKEN` | Unset | Optional GitHub auth; first nonempty token wins in this order. Never commit tokens. |

### Offline worker stub

For tests or when you skip the encoder:

```bash
npm run stub
# JEVLIKE_BASE_URL=http://127.0.0.1:8766 npm start
```

`[stub:scam]` in a message body forces the stub high-risk preset on **`/v1/score`** (eval only).

## Choose operator mode

On the first ready session the bot polls your own chat:

- **自動封鎖同封存** — automatic archive and graded block. After each archive or block you get a receipt with chat-list name, phone, and local reason. A Cantonese note uses masked text only after `POST /v1/mask`. Name and phone stay on this machine.
- **逐條問我** — forwards suspicious DMs and waits for **封鎖並封存**, **只封存**, or **留低**. The explanation model cannot choose for you. Saved contacts block only when you pick **封鎖並封存**.

Until you answer the first poll, suspicious chats archive and nobody blocks. `OPERATOR_MODE=auto` or `OPERATOR_MODE=guided` skips the question. Send `設定` in your own chat to choose again.

WhatsApp writes (block, rename, mute, archive, receipts) run one chat at a time with `WA_ACTION_GAP_MS` between calls.

## Run tests

```bash
npm test
npm run lint
python -m pip install ruff==0.17.6
ruff check .
npm run typecheck
npm run test:e2e
```

`npm test` is offline: in-process stub, no live WhatsApp, no encoder download. GitHub Actions runs it on pull requests and on `main`.

The mocked HTTP E2E test drives the real inbound modules against local mask and LLM servers. The optional boot smoke (`npm run test:e2e:boot`) launches Chromium and waits for the WhatsApp QR event without scanning it; install Chrome first with `npx puppeteer browsers install chrome`. CI treats that network-dependent boot as best-effort.

Smoke check for mask and dry LLM transport:

```bash
node scripts/review-eval.js --llm dry --mode triggers
```

Default fixture: `fixtures/review-eval-smoke.json`. Full labelled HK run: `--from-run` plus your `jevlike-lab` export and `--split real_test`.

## Optional Docker

The image runs WhatsApp Web (Chromium) only. Run jevlike beside it and set `JEVLIKE_BASE_URL`.

```bash
docker build -t scam-detection-jev .
docker run --rm -it \
  -e JEVLIKE_BASE_URL=http://host.docker.internal:8766 \
  -v "$(pwd)/.wwebjs_auth:/app/.wwebjs_auth" \
  scam-detection-jev
```

You still need a terminal or logs to read the QR code. The image runs as user `node`. Fix ownership if `.wwebjs_auth` was created as root.

## Optional agent smoke (no QR)

[`.cursor/skills/verify-scam-bot/`](.cursor/skills/verify-scam-bot/SKILL.md):

```bash
.cursor/skills/verify-scam-bot/bin/launch-stub
.cursor/skills/verify-scam-bot/bin/doctor
.cursor/skills/verify-scam-bot/bin/drive-mask-before-llm
.cursor/skills/verify-scam-bot/bin/drive-agents-invariants
```

`bin/drive-score-archive` is lab-only (`POST /v1/score`). Live proof is mask then LLM.

## Layout

| Path | Role |
|------|------|
| `whatsapp-bot.js` | WhatsApp Web client, QR, archive, graded block |
| `lib/handle-incoming.js` | Heuristics, mask, LLM orchestration |
| `lib/jevlike-client.js` | `createMaskClient`, `/v1/mask` |
| `lib/llm-review.js` | Primary LLM after mask |
| `lib/context-llm.js` | Context LLM when `CONTEXT_LLM_ENABLED` is on |
| `lib/malicious-hosts.js`, `data/malicious-hosts.json` | Hosts that may auto-block unsaved contacts |
| `jevlike_serve.py` | Worker: `/v1/mask` required; `/v1/score` optional for lab |
| `lab/score-message.js` | Lab-only `/v1/score` helper |
| `scripts/download_jevlike_ckpt.sh` | Pulls r1 head from GitHub Release |

## Known security advisories

`npm audit` reports **5 high** findings from `extract-zip` via Puppeteer. Every released `extract-zip` version is affected. `npm audit fix` would downgrade Puppeteer and break `whatsapp-web.js`.

Practical exposure is low: `extract-zip` runs only when Puppeteer unpacks Chrome from Google's CDN. It is not on the WhatsApp message path.

**Do not run `npm audit fix`.**

## Disclaimer

Personal filter only. WhatsApp Web automation may violate WhatsApp terms and can log you out. Do not use it on accounts you do not own. Review `blocks.jsonl` before you trust a block label as a final name.
