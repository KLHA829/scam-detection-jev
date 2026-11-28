# scam-detection-jev

Personal **WhatsApp Web** bot: it masks PII on your machine, sends redacted text to an **OpenAI-compatible** chat API, archives suspicious 1:1 DMs, and blocks **unsaved** contacts only when a URL matches [`data/malicious-hosts.json`](data/malicious-hosts.json).
Link-rule hits require AI confirmation before archive. Curated URL and email-domain matches also go through mask → LLM; only a curated URL match can auto-block an unsaved contact after AI confirms scam, and an email match never auto-blocks. Saved contacts get a review card instead of an automatic archive or block.

Local [jevlike](https://github.com/vinnylarouge/jevlike) serves **`POST /v1/mask`**. Judgment uses **`LLM_REVIEW_*`**. The frozen scam head (`jevlike_hf_chinese_roberta_r1.pt`) is for **lab eval** only. There is no LightJev or `SCORER=model_v2` path.

For why the live path works this way, see [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md). For thresholds and decision labels, see [SCORING_RUBRIC.md](SCORING_RUBRIC.md).

## Before you start

You need **Node.js 20+**, **Python 3.11+** (3.10 works; 3.11 is preferred), **Go 1.26+** (for the default `whatsmeow` sidecar; omit only if using `WA_TRANSPORT=wwebjs` with Chrome), a WhatsApp account you may link via WhatsApp Web, and an OpenAI-compatible API for `LLM_REVIEW_*`.

Copy [`.env.example`](.env.example) to `.env`. Product invariants live in [AGENTS.md](AGENTS.md). Do not run `npm audit fix` (it downgrades Puppeteer and breaks the bot). See [Known security advisories](#known-security-advisories).

On Windows/macOS/Linux, the default transport (`WA_TRANSPORT=whatsmeow`) uses the Chromium-free Go sidecar (`wa-bridge/`) instead of Chrome (requires **Go 1.26+**; run `npm run wa-bridge:build` before `npm start`). Install Chrome only if you set `WA_TRANSPORT=wwebjs`:

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
npm run wa-bridge:build     # build default whatsmeow sidecar (Go 1.26+)
scripts/download_jevlike_ckpt.sh
scripts/download_pii_mask_ckpt.sh

# Terminal 1 — activate the venv; first start downloads the encoder once (~400 MB)
python jevlike_serve.py

# Terminal 2 — verify before starting the bot
curl -s localhost:8766/health
# Must include "pii_mask": true ("ok": true alone is not enough)
curl -s -X POST localhost:8766/v1/mask -H 'content-type: application/json' -d '{"messages":["我叫陳大文，電話 91234567"]}'
# Must return spans, not a 503 error
npm start
```

Scan the QR code. By default (`WA_TRANSPORT=whatsmeow`), session keys stay in `wa-bridge.db` (gitignored; `.wwebjs_auth/` when using `WA_TRANSPORT=wwebjs`). Keep that file/folder across restarts. Deleting it forces a new login and often logs the session out.

Set `JEVLIKE_DEVICE=cuda` only when you have a compatible NVIDIA GPU. CPU is the default on a Pi.

The r1 download alone cannot serve `/v1/mask`: `scripts/download_pii_mask_ckpt.sh` downloads the separate published PII head and verifies its SHA-256 (see [models/README.md](models/README.md)). Alternatively, export `JEVLIKE_MASK_CKPT=/path/to/jevlike_hf_pii_mask.pt` for an existing trained head in the worker shell. `jevlike_serve.py` does not read `.env`; export optional lab `JEVLIKE_CKPT` there too. Restart the worker after downloading, training, or changing the head. Without it, `/v1/mask` returns 503 and the bot skips the LLM.

### Raspberry Pi (正體中文)

需要 **Node.js 20+**、**Python 3.11+**、**Go 1.26+**（預設 `whatsmeow` sidecar 需要）、64-bit OS（Raspberry Pi OS 64-bit / aarch64）。

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
npm run wa-bridge:build
scripts/download_jevlike_ckpt.sh
scripts/download_pii_mask_ckpt.sh

python jevlike_serve.py   # terminal 1

# terminal 2：先確認脫敏頭已載入，再啟動 bot
curl -s localhost:8766/health
# 必須包含 "pii_mask": true；只有 "ok": true 並不足夠
curl -s -X POST localhost:8766/v1/mask -H 'content-type: application/json' -d '{"messages":["我叫陳大文，電話 91234567"]}'
# 應回傳 spans，不能是 503 錯誤
npm start                 # terminal 2
```

掃 QR。預設（`WA_TRANSPORT=whatsmeow`）Session 存在 `wa-bridge.db`（若設為 `WA_TRANSPORT=wwebjs` 則在 `.wwebjs_auth/`）。權重見 Release [jevlike-hf-r1](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1) 同 [jevlike-pii-mask-hn2](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-pii-mask-hn2)。不要把 `.pt`、`.db` 或 encoder 推進 git。詳見 [models/README.md](models/README.md)。

Pi 建議 4 GB RAM 以上。`JEVLIKE_DEVICE=cpu` 為預設。

只下載 r1 並不會產生脫敏頭；`scripts/download_pii_mask_ckpt.sh` 會下載已發佈嘅 `models/jevlike_hf_pii_mask.pt` 並核對 SHA-256，唔會覆蓋 r1。首次 worker start 會下載約 400 MB 編碼器。亦可在其他機器訓練後複製頭檔，並在啟動 worker 的 shell 執行 `export JEVLIKE_MASK_CKPT=/path/to/jevlike_hf_pii_mask.pt`。Worker 不會讀取 `.env`；下載、訓練或換頭後須重新啟動，再檢查上述兩個端點。缺少脫敏頭時 `/v1/mask` 會回 503，bot 會跳過 LLM。

### Windows notes

- `scripts/download_jevlike_ckpt.sh` under git-bash uses a relative `--dir` so native `gh.exe` does not write to `C:\c\Users\...`.
- Do not run `npm audit fix`. See [Known security advisories](#known-security-advisories).

### WhatsApp transport (`whatsmeow` default / Linux)

By default (`WA_TRANSPORT=whatsmeow`), the bot uses the Chromium-free pure-Go `whatsmeow` sidecar (`wa-bridge/`, Linux `amd64`/`arm64`, macOS, and Windows; requires **Go 1.26+** to build; legacy Chromium + `whatsapp-web.js` remains available with `WA_TRANSPORT=wwebjs`):

```bash
# Build native sidecar binary into wa-bridge/wa-bridge (or wa-bridge.exe on Windows)
npm run wa-bridge:build

# Cross-compile for Linux from Windows or macOS (writes wa-bridge/wa-bridge-linux-amd64 without overwriting native binary; pass --out or WA_BRIDGE_BIN to customize)
node scripts/build-wa-bridge.js --goos linux --goarch amd64

# Start bot with auto-managed sidecar (WA_TRANSPORT=whatsmeow and auto-start are enabled by default when WA_BRIDGE_URL/WA_BRIDGE_TOKEN are unset)
OPERATOR_MODE=guided npm start
```

Session keys and local message cache live in `WA_BRIDGE_DB_PATH` (default `./wa-bridge.db`, `0600` on POSIX) and `WA_BRIDGE_CURSOR_PATH` (default `./wa-bridge-cursor.json` for standalone sidecars; kept in memory under auto-start unless set). Keep `wa-bridge.db` across restarts to avoid re-scanning the QR code.

## Point the bot at your API

Set `LLM_REVIEW_API_URL`, `LLM_REVIEW_MODEL`, and `LLM_REVIEW_API_KEY` when your server needs auth. `LLM_REVIEW_ENABLED` defaults to **true**.

Live inbound order (after filters): link heuristics on the current message, then mask and LLM. **`CONTEXT_LLM_ENABLED` defaults to on** (masked transcript of recent 1:1 messages, including your own marked `user:`). Allowlisted official brand domains stay readable and are named in the prompt; lookalike/unknown domains and PII stay masked as typed placeholders (`<PHONE_1>`, `<PII_1>` …). Set `CONTEXT_LLM_ENABLED=0` or `false` for single-message primary LLM only.

On a first message from an unsaved number with no earlier turn, a model archive recommendation acts only on strong evidence (`strong: true`), otherwise holding until the next message; unsolicited investment/trading/health pitches (`pitch: true`) only label an unsaved sender `（可疑推銷）` (and clear the bot-written label on a later confident `no_action` with `pitch: false`). Chats you restore from the archive (`USER_RESTORED_CHATS_PATH`) are routed to your self-chat review card on model verdicts like saved contacts.

If `POST /v1/mask` fails, the bot skips the LLM and does not archive or block (fail closed). This includes curated blocklist matches.

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
| `JEVLIKE_DEVICE` | `cpu` | Worker device. Only exactly `cuda` checks CUDA availability and falls back to CPU when unavailable; `cuda:0` and other device strings bypass that check. |
| `JEVLIKE_CKPT`, `JEVLIKE_CHECKPOINT` | `models/jevlike_hf_chinese_roberta_r1.pt` | Scorer/encoder checkpoint; first nonempty setting wins, then the default file. Missing file is an error. Scoring is lab-only. |
| `JEVLIKE_ENCODER`, `JEVLIKE_HF_MODEL` | Checkpoint `hf_model`, then `hfl/chinese-roberta-wwm-ext` | Encoder overrides, in that precedence order. |
| `JEVLIKE_OPTIONS` | `not_scam,scam` | Scorer labels (lab); requires at least two. |
| `JEVLIKE_MASK_CKPT` | `models/jevlike_hf_pii_mask.pt` if present | PII head. A missing configured file logs a warning and the worker still starts without the head; `/v1/mask` returns 503 until a head is loaded. |
| `HEURISTIC_ENABLED` | `true` | Enables structural link rules and curated blocklist matching; matches still require mask → LLM confirmation. |
| `BLOCK_ENABLED` | `true` | Enables malicious-host auto-block of unsaved contacts, not model-based blocking. |
| `MALICIOUS_HOSTS_PATH` | `data/malicious-hosts.json` in the repo | Maintained host list override. |
| `MALICIOUS_FEED_HOSTS_PATH` | `data/threat-feed-hosts.json` in the repo | Offline PhishTank verified-online snapshot. A feed host match **never archives or blocks**; it only adds a line to the review LLM prompt as strong scam evidence. Refresh with `node scripts/update-threat-feeds.js` — manual/cron only; the bot itself never downloads. |
| `MALICIOUS_HOSTS_ALLOW_EMPTY` | Off | Set `1` or `true` to allow a reload with `hosts:[]` to clear the in-memory list. |
| `BLOCK_LOG_PATH` | `./blocks.jsonl` | Local block history used by operator commands. |
| `BOT_CONTACT_NAMES_PATH` | `./bot-contact-names.json` | Contacts whose name the bot wrote (block or `（可疑推銷）` label); only those names do not count as saved contacts. |
| `USER_RESTORED_CHATS_PATH` | `./user-restored-chats.json` | Chats the user moved out of the archive. Model verdicts there only send the self-chat review card, as for a saved contact; malicious-host matches still act. |
| `OPERATOR_MODE` | Unset | `auto` or `guided` pins mode; otherwise use saved choice or ask on first run. |
| `OPERATOR_MODE_PATH`, `REVIEW_QUEUE_PATH` | `./operator-mode.json`, `./review-queue.json` | Saved operator mode and guided review queue. |
| `WA_ACTION_GAP_MS` | `3000` | Gap between queued WhatsApp writes in ms. |
| `CONTEXT_TURNS` | `4` | In-memory thread window capacity including current text; not a live scoring window. |
| `CONTEXT_LLM_ENABLED` | On | Use masked recent-message review; `0` or `false` selects single-message review. |
| `CONTEXT_LLM_MESSAGES` | `10` | Recent 1:1 message limit (inbound plus your own messages) including current message; capped at 10. Invalid values or values below 1 use the default. |
| `LLM_REVIEW_ENABLED` | `true` | Enable LLM judgment; disabling it fails closed with no archive or block. |
| `LLM_REVIEW_ALL` | `false` | Legacy compatibility flag; no longer affects review enablement or trigger selection. `LLM_REVIEW_ENABLED=false` disables both review paths. |
| `LLM_REVIEW_API_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` | Empty | First nonempty URL wins, in this order. No implicit OpenAI endpoint; without a URL, review fails closed. Whitespace and one trailing slash are removed. A URL ending in `/chat/completions` is kept; one ending in `/v1` gets `/chat/completions` appended; all others get `/v1/chat/completions` appended (suffix checks are case-insensitive). For other API paths, supply the full URL ending in `/chat/completions`. |
| `LLM_REVIEW_API_KEY`, `OPENAI_API_KEY` | Empty | First nonempty key wins; empty omits the authorization header. |
| `LLM_REVIEW_MODEL` | `gpt-4o-mini` | Chat model name. |
| `LLM_REVIEW_TIMEOUT_MS` | `8000` | Chat request timeout in ms. |
| `LLM_REVIEW_MIN_CONFIDENCE` | `0.7` | Minimum confidence for primary or context review to archive. |
| `LLM_REVIEW_COOLDOWN_MS` | `600000` | Per-chat cooldown in ms after successful automatic archive or guided archive recommendation; nonpositive disables it. |
| `LLM_REVIEW_COOLDOWN_PATH` | `./llm-review-cooldown.json` | Persist cooldown across restarts. Save failure keeps it in memory only. |
| `PUPPETEER_EXECUTABLE_PATH` | Unset | Override Puppeteer's browser executable. |
| `PUPPETEER_NO_SANDBOX` | Unset | Exactly `1` disables Chromium sandboxing. Root already disables it; do not opt in unless required. |
| `PUPPETEER_SKIP_DOWNLOAD` | Unset | Puppeteer installation option to skip browser download, not a bot behavior flag. |
| `WA_TRANSPORT` | `whatsmeow` | Transport backend: `whatsmeow` (Chromium-free `wa-bridge` Go sidecar, default) or `wwebjs` (legacy Chromium / `whatsapp-web.js`). |
| `WA_BRIDGE_AUTO_START` | Auto (`On` if `WA_BRIDGE_URL`/`WA_BRIDGE_TOKEN` unset) | Spawn and supervise the local `wa-bridge` binary automatically (`1`/`true` forces auto-start; `0`/`false` disables it for an external sidecar). |
| `WA_BRIDGE_BIN` | `wa-bridge/wa-bridge` (`.exe` on Windows) | Path to the compiled `wa-bridge` binary for `WA_BRIDGE_AUTO_START=1`. |
| `WA_BRIDGE_URL` | `http://127.0.0.1:8767` | Loopback base URL (`127.0.0.1`, `localhost`, or `::1`) of an external `wa-bridge` process. |
| `WA_BRIDGE_TOKEN` | Empty | Required bearer token when connecting to an external `wa-bridge`; auto-generated when `WA_BRIDGE_AUTO_START=1` leaves it unset. |
| `WA_BRIDGE_DB_PATH` | `./wa-bridge.db` | SQLite database storing the `whatsmeow` session, poll options, and recent text message cache (`0600` on POSIX). |
| `WA_BRIDGE_CURSOR_PATH` | `./wa-bridge-cursor.json` | Persisted SSE replay cursor and handled self-message IDs for the `whatsmeow` adapter. |
| `WA_BRIDGE_TIMEOUT_MS` | `15000` | HTTP/startup timeout in ms for `wa-bridge` calls. |
| `WA_BRIDGE_HOST`, `WA_BRIDGE_PORT`, `WA_BRIDGE_LOG_LEVEL` | `127.0.0.1`, `8767`, `WARN` | Standalone `wa-bridge` loopback bind host/port and log level (`ERROR` \| `WARN` \| `INFO` \| `DEBUG`). |

### Checkpoint download helper settings

These are user-facing setup options for `scripts/download_jevlike_ckpt.sh`.

| Setting | Default | Meaning |
|---|---|---|
| `JEVLIKE_RELEASE_REPO` | `KLHA829/scam-detection-jev` | GitHub release repository. |
| `JEVLIKE_RELEASE_TAG` | `jevlike-hf-r1` | Release tag. |
| `JEVLIKE_RELEASE_ASSET` | `jevlike_hf_chinese_roberta_r1.pt` | Asset filename. |
| `JEVLIKE_DOWNLOAD_URL` | `https://github.com/{repo}/releases/download/{tag}/{asset}` | Direct download URL built from the settings above. |
| `JEVLIKE_CKPT` | Repo `models/jevlike_hf_chinese_roberta.pt` | Helper destination (different from the worker's r1 default). Unless forced, an existing destination passing size and non-HTML checks causes a successful early exit without checking for the named release asset; the worker's default r1 file may still be missing. After a download, the named asset is also kept beside the destination. |
| `JEVLIKE_CKPT_MIN_BYTES` | `1000000` | Minimum size accepted as a checkpoint. |
| `JEVLIKE_CKPT_FORCE` | `0` | Exactly `1` bypasses the existing-destination shortcut and downloads again. Otherwise a valid-looking destination is enough to exit successfully, even if the named release asset (including the worker's default r1 file) is absent. |
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

- **自動封鎖同封存** — automatic archive and graded block for unsaved contacts only. After each archive or block you get a receipt with chat-list name, phone, and local reason. A Cantonese note uses masked text only after `POST /v1/mask`. Name and phone stay on this machine.
- **逐條問我** — forwards suspicious DMs and waits for **封鎖並封存**, **只封存**, or **留低**. The explanation model cannot choose for you.

Suspicious DMs from saved contacts always get a review card instead of an automatic archive or block, in either mode and before setup. Until you answer the first poll, only unsaved chats can archive automatically, and nobody is blocked automatically. `OPERATOR_MODE=auto` or `OPERATOR_MODE=guided` skips the question. Send `設定` in your own chat to choose again.

WhatsApp writes (block, rename, mute, archive, receipts) run one chat at a time with `WA_ACTION_GAP_MS` between calls.

## Run tests

```bash
node scripts/ci-static-gates.js
npm test
npm run lint
python -m pip install ruff==0.17.6
ruff check .
npm run typecheck
npm run test:e2e
npm run test:e2e:mini-wa
(cd wa-bridge && go vet ./... && go test ./...)   # Linux/macOS CI uses go test -race ./...
bash scripts/ci-verify-smoke.sh
```

`npm test` is offline: in-process stub, no live WhatsApp, no encoder download. GitHub Actions runs it on pull requests and on `main`.

The mocked HTTP E2E test (`test:e2e`) drives the real inbound modules against local mask and LLM servers, and `test:e2e:mini-wa` drives the Mini WhatsApp sandbox UI and bot end-to-end without QR login. Two optional best-effort boot checks wait for the WhatsApp QR event without scanning it: `npm run test:e2e:boot` launches Chromium (`npx puppeteer browsers install chrome` first), while `npm run test:e2e:boot:whatsmeow` builds `wa-bridge/` and verifies Chromium-free QR emission via `whatsmeow` (needs Go 1.26+). CI treats both network-dependent boot checks as best-effort.

Smoke check for mask and dry LLM transport:

```bash
node scripts/review-eval.js --llm dry --mode all
```

Default fixture: `fixtures/review-eval-smoke.json`. Full labelled HK run: `--from-run` plus your `jevlike-lab` export and `--split real_test`.

False block / false archive rate on about 300 legitimate messages (family, banks, delivery, clinics, government, forwarded anti-scam warnings; Chinese, English and mixed). Each runs through the real inbound handler from an unsaved and a saved contact, with the model always answering not_scam, so every hit comes from the bot's own rules:

```bash
node scripts/legit-fpr.js
```

`npm test` fails when the list of false positives changes from `fixtures/legit-fpr-baseline.json`.

## Optional Docker

The container image uses a multi-stage Linux build (`golang:1.26-bookworm` → `node:22-bookworm-slim`) that compiles the pure-Go `wa-bridge` sidecar and runs `WA_TRANSPORT=whatsmeow` with **no Chromium**. Run jevlike beside it and set `JEVLIKE_BASE_URL`.

```bash
docker build -t scam-detection-jev .
mkdir -p wa-data
docker run --rm -it \
  -e JEVLIKE_BASE_URL=http://host.docker.internal:8766 \
  -v "$(pwd)/wa-data:/data" \
  scam-detection-jev
```

State files (`wa-bridge.db`, `wa-bridge-cursor.json`, `bot-contact-names.json`, `user-restored-chats.json`, `operator-mode.json`, `review-queue.json`, `llm-review-cooldown.json`, `blocks.jsonl`) default to `/data/...` inside the container, so mounting `-v "$(pwd)/wa-data:/data"` preserves your WhatsApp session, restored-chat overrides, and label history across restarts without storing secrets in the image. `wa-data/` and `**/wa-bridge.db*` are excluded in `.dockerignore` and `.gitignore` so rebuilding the image never bakes your live database or keys into a new image. When upgrading from the legacy Chromium container (`.wwebjs_auth`), copy `bot-contact-names.json` and `user-restored-chats.json` (plus any persisted `operator-mode.json`, `review-queue.json`, or `blocks.jsonl`) into `./wa-data/` before starting the new container so previously bot-labelled contacts stay recognized as unsaved and user-restored chats stay protected. You still need a terminal or logs on first run to read the QR code. The image runs as user `node`; ensure host permissions on `./wa-data` allow `node` (uid `1000`) to write. To fall back to the legacy Chromium adapter instead, add Puppeteer's Chromium packages in `Dockerfile` and override `-e WA_TRANSPORT=wwebjs`.

## Mini WhatsApp Sandbox (no QR login)

Run a local Chromium-free fake `wa-bridge` (`whatsmeow` HTTP + SSE protocol) with a WhatsApp-style Web UI so you can test inbound scam messages, edits, Self-Chat Poll cards, `@lid` resolution, contact states, and archive/block actions without scanning a QR code:

```bash
# Offline UI + bot + built-in stub mask & LLM (pass --isolated-env to keep state in a temp dir):
npm run mini-wa -- --with-bot --with-stub --isolated-env

# Automated Mini WhatsApp end-to-end smoke test:
npm run test:e2e:mini-wa
```

Open `http://127.0.0.1:8787` in your browser. To test against your real `jevlike_serve.py` and real OpenAI-compatible LLM without overwriting your live bot state (`operator-mode.json`, `review-queue.json`, etc.), run `npm run mini-wa` and connect `npm start` using the `Bearer Token` printed in the terminal plus isolated state paths:

```bash
STATE_DIR=$(mktemp -d) && \
WA_TRANSPORT=whatsmeow WA_BRIDGE_AUTO_START=0 WA_BRIDGE_URL=http://127.0.0.1:8767 WA_BRIDGE_TOKEN=<printed-token> \
WA_BRIDGE_CURSOR_PATH="$STATE_DIR/cursor.json" OPERATOR_MODE_PATH="$STATE_DIR/operator-mode.json" \
REVIEW_QUEUE_PATH="$STATE_DIR/review-queue.json" LLM_REVIEW_COOLDOWN_PATH="$STATE_DIR/cooldown.json" \
BOT_CONTACT_NAMES_PATH="$STATE_DIR/bot-contact-names.json" USER_RESTORED_CHATS_PATH="$STATE_DIR/restored.json" \
BLOCK_LOG_PATH="$STATE_DIR/blocks.jsonl" npm start
```

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
| `whatsapp-bot.js` | WhatsApp client orchestration, QR, archive, graded block |
| `lib/wa-transport/` | `WaTransport` boundary (`whatsmeow` default HTTP/SSE adapter, `wwebjs` legacy fallback) |
| `wa-bridge/` | Pure-Go `whatsmeow` + `modernc.org/sqlite` sidecar (Linux/macOS/Windows, no Chromium/CGO) |
| `scripts/mini-whatsapp.js`, `lib/mini-whatsapp*.js` | Local `wa-bridge` sandbox + Web UI for testing without QR login |
| `lib/handle-incoming.js` | Heuristics, mask, LLM orchestration |
| `lib/jevlike-client.js` | `createMaskClient`, `/v1/mask` |
| `lib/llm-review.js` | Primary LLM after mask |
| `lib/context-llm.js` | Context LLM when `CONTEXT_LLM_ENABLED` is on |
| `lib/malicious-hosts.js`, `data/malicious-hosts.json` | Hosts that may auto-block unsaved contacts. `data/threat-feed-hosts.json` is a PhishTank verified-online snapshot from `scripts/update-threat-feeds.js`; it is a review-LLM signal only and never archives or blocks |
| `jevlike_serve.py` | Worker: `/v1/mask` required; `/v1/score` optional for lab |
| `lab/score-message.js` | Lab-only `/v1/score` helper |
| `scripts/download_jevlike_ckpt.sh` | Pulls r1 head from GitHub Release |

## Known security advisories

`npm audit` reports **5 high** findings from `extract-zip` via Puppeteer. Every released `extract-zip` version is affected. `npm audit fix` would downgrade Puppeteer and break `whatsapp-web.js`.

Practical exposure is low: `extract-zip` runs only when Puppeteer unpacks Chrome from Google's CDN. It is not on the WhatsApp message path.

**Do not run `npm audit fix`.**

## Disclaimer

Personal filter only. WhatsApp Web automation may violate WhatsApp terms and can log you out. Do not use it on accounts you do not own. Review `blocks.jsonl` before you trust a block label as a final name.
