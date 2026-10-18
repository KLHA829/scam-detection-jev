# scam-detection-jev

Local **WhatsApp Web** bot that **masks PII locally**, sends masked text to an **OpenAI-compatible LLM** for each 1:1 DM, **archives** risky chats, and **blocks unsaved contacts only** when a URL matches the malicious-host list.

**Local worker (Pi / CPU):** [jevlike](https://github.com/vinnylarouge/jevlike) serves **`POST /v1/mask`** (PII head). Heavy judgment runs on your **`LLM_REVIEW_*`** API. The frozen scam scorer (`jevlike_hf_chinese_roberta_r1.pt`) remains for **offline lab eval**, not live decisions. There is **no** LightJev / `SCORER=model_v2` fallback.

**Blocking** is tuned for **elderly primary users** (near-zero false block). Unsaved contacts are **auto-blocked only** on [`data/malicious-hosts.json`](data/malicious-hosts.json). Lookalike and soliciting short links **archive** only. LLM paths never auto-block. Saved contacts are never auto-blocked. It does **not** call Scameter or any phone/URL registry.

Historical jevlike archive FPR on a 366-row HK set is documented in git history / lab notes; the **live product bar** is mask → LLM until measured with `scripts/review-eval.js --mode all`.

## What it does

1. Reads 1:1 message bodies (including saved contacts).
2. **Link heuristics** on the current message → archive (skip LLM) when matched.
3. Else **mask** (`POST /v1/mask`) → **LLM** (`LLM_REVIEW_*`, default **on**) → archive or ignore.
4. **Blocks** an unsaved contact only when the current message matches the malicious-host list. Also mutes the chat. Link-rule archives stay archive-only. Saved contacts stay archive-only.
5. Optional **`CONTEXT_LLM_ENABLED`** fork: masked multi-message transcript instead of single-message LLM.

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
- 設定以 [`.env.example`](.env.example) 同 [AGENTS.md](AGENTS.md) Invariants 為準（主線 LLM 預設 **開**）。

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

### Configuration

**Single source of truth:** copy [`.env.example`](.env.example) to `.env` and read [AGENTS.md](AGENTS.md) (Invariants + Current state). Live inbound uses **`POST /v1/mask`** then primary LLM judgment; **`POST /v1/score`** is lab/eval only (`lab/score-message.js`, `scripts/review-eval.js`).

Offline worker stub (tests / no encoder):

```bash
npm run stub
# JEVLIKE_BASE_URL=http://127.0.0.1:8766 npm start
```

Include `[stub:scam]` in a message body to force the stub’s high-risk preset on **`/v1/score`** (eval only).

Keep `.wwebjs_auth/` across restarts. Deleting it forces a new QR login, which is a common way to get the session logged out. The only chats this bot messages are your own: setup, a review when you ask first, and a receipt after each archive or block. Block, rename, mute, and archive run one chat at a time, with `WA_ACTION_GAP_MS` between each call. The contact is saved only after the block succeeds.

### First-time choice

On the first ready session the bot sends a poll to your own WhatsApp chat:

- **自動封鎖同封存** — today's behaviour. After each archive or block, your own chat gets a receipt: the chat-list name, the phone, and the local reason. A Cantonese note is requested only after `POST /v1/mask`, using `LLM_REVIEW_API_URL` / `LLM_REVIEW_MODEL`. The name and phone are attached on this machine and are not sent to the chat API. If masking or the model fails, the receipt still arrives and the model section says the explanation is unavailable.
- **逐條問我** — the same suspicion line, but nothing is archived or blocked until you choose. The original message is forwarded to you. A local note gives the lure label and whether the contact would have been blocked. A separate Cantonese explanation is requested only after `POST /v1/mask`. If masking or the model fails, the poll still appears and the model section says the explanation is unavailable. The model cannot press a choice for you. After you pick **封鎖並封存** or **只封存**, the confirmation repeats the chat-list name, the phone, and the local reason. It does not call the model again.

Until you answer, suspicious chats are archived and nobody is blocked. `OPERATOR_MODE=auto` or `OPERATOR_MODE=guided` skips the question. Send `設定` in your own chat to choose again. Saved contacts are still never blocked unless you explicitly pick **封鎖並封存**. The first choice on a review poll is the one that runs.

### Knobs (no code change)

See [`.env.example`](.env.example), [AGENTS.md](AGENTS.md), and [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented). Highlights:

- Link heuristics (lookalike, soliciting short link) → archive only; **malicious-host list** may auto-block unsaved contacts.
- Non-heuristic DMs → **`POST /v1/mask`** → primary LLM (`LLM_REVIEW_ENABLED` default **true**). Mask or LLM failure → ignore (fail closed).
- `MALICIOUS_HOSTS_PATH` / hot reload: empty `hosts:[]` keeps the previous list unless `MALICIOUS_HOSTS_ALLOW_EMPTY=1`.
- Lab jevlike thresholds (`ARCHIVE_THRESHOLD`, `/v1/score`) — [SCORING_RUBRIC.md](SCORING_RUBRIC.md) only; not live inbound.

## 決策順序（繁中）

同 [DESIGN_DECISIONS.md — Action matrix](DESIGN_DECISIONS.md#action-matrix-implemented)：連結規則 →（可選）上文 LLM → mask → 主 LLM → 惡意域名 block 政策。設定詳見 [`.env.example`](.env.example) 同 [AGENTS.md](AGENTS.md)。

## Tests

`npm test` is **offline**: in-process stub probabilities, no live WhatsApp, no encoder download. GitHub Actions runs it on every pull request and on pushes to `main`.

```bash
npm test
```

Offline stage-1+2 pipeline check (stub mask, dry LLM transport, no API key):

```bash
node scripts/review-eval.js --llm dry --mode triggers
```

The default fixture is `fixtures/review-eval-smoke.json` (`ci_smoke` split). For the full labelled HK run, pass `--from-run` to your `jevlike-lab` export and `--split real_test`.

## Docker (optional)

The Node image runs WhatsApp Web (Chromium) only. Run jevlike as a sibling process and point `JEVLIKE_BASE_URL` at it.

```bash
docker build -t scam-detection-jev .
docker run --rm -it \
  -e JEVLIKE_BASE_URL=http://host.docker.internal:8766 \
  -v "$(pwd)/.wwebjs_auth:/app/.wwebjs_auth" \
  scam-detection-jev
```

QR login still needs a terminal that can show the code (or inspect container logs). The image runs as the `node` user so Chromium can keep its sandbox. A `.wwebjs_auth` directory created as root has to be given to that user before it will open.

## Offline verification (agents / CI)

Operator smoke without WhatsApp QR lives under [`.cursor/skills/verify-scam-bot/`](.cursor/skills/verify-scam-bot/SKILL.md):

```bash
.cursor/skills/verify-scam-bot/bin/launch-stub
.cursor/skills/verify-scam-bot/bin/doctor          # worth_driving: yes
.cursor/skills/verify-scam-bot/bin/drive-mask-before-llm   # primary smoke
.cursor/skills/verify-scam-bot/bin/drive-agents-invariants # AGENTS locks
```

`bin/drive-score-archive` is **lab-only** (`POST /v1/score`); live inbound proof is mask → LLM. Full feature map: `.cursor/skills/verify-scam-bot/features/README.md`.

## Layout

- `whatsapp-bot.js` — WhatsApp Web client, QR, archive and graded block, self-chat setup poll
- `lib/operator-mode.js` — `auto` or `guided`, stored in `operator-mode.json`
- `lib/review-guide.js` — masked Cantonese explanation for guided review
- `lib/jevlike-client.js` — HTTP client (`createMaskClient`, `/v1/mask`)
- `lib/score-message.js` — rubric load and threshold helpers
- `lab/score-message.js` — lab-only `/v1/score` helper
- `test/support/mask-spans-stub.js` — offline regex stub for `stub-jevlike.js` tests
- `lib/llm-review.js` — primary OpenAI-compatible judgment after mask
- `lib/scam-intent.js` — solicit helpers used by short-link rules, not as an archive gate
- `lib/malicious-hosts.js`, `data/malicious-hosts.json` — operator-maintained hosts that may auto-block unsaved contacts
- `jevlike_serve.py` — persistent worker (`POST /v1/mask` required; `/v1/score` optional for eval)
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
