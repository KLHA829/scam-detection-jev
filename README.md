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

# Terminal 1 — first start downloads hfl/chinese-roberta-wwm-ext (~400 MB)
python jevlike_serve.py

# Terminal 2
npm start
```

Scan the QR code. Session data stays in `.wwebjs_auth/` (gitignored). Keep that folder across restarts. Deleting it forces a new login and often logs the session out.

Set `JEVLIKE_DEVICE=cuda` only when you have a compatible NVIDIA GPU. CPU is the default on a Pi.

`jevlike_serve.py` does not read `.env`. Export `JEVLIKE_MASK_CKPT` (and optional lab `JEVLIKE_CKPT`) in the shell that starts the worker.

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

python jevlike_serve.py   # terminal 1
npm start                 # terminal 2
```

掃 QR。Session 在 `.wwebjs_auth/`。權重見 Release [jevlike-hf-r1](https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1)。不要把 `.pt` 或 encoder 推進 git。詳見 [models/README.md](models/README.md)。

Pi 建議 4 GB RAM 以上。`JEVLIKE_DEVICE=cpu` 為預設。

### Windows notes

- `scripts/download_jevlike_ckpt.sh` under git-bash uses a relative `--dir` so native `gh.exe` does not write to `C:\c\Users\...`.
- Do not run `npm audit fix`. See [Known security advisories](#known-security-advisories).

## Point the bot at your API

Set `LLM_REVIEW_API_URL`, `LLM_REVIEW_MODEL`, and `LLM_REVIEW_API_KEY` when your server needs auth. `LLM_REVIEW_ENABLED` defaults to **true**.

Live inbound order (after filters): link heuristics on the current message, then mask and LLM. **`CONTEXT_LLM_ENABLED` defaults to on** (masked transcript of recent inbound messages). Set `CONTEXT_LLM_ENABLED=0` or `false` for single-message primary LLM only.

If `POST /v1/mask` fails, the bot skips the LLM and does not archive (fail closed). Link-rule archives still run without the LLM.

Full flag list: [`.env.example`](.env.example) and [AGENTS.md](AGENTS.md). Behaviour matrix: [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented). Lab-only jevlike thresholds: [SCORING_RUBRIC.md](SCORING_RUBRIC.md).

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
