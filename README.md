# scam-detection-jev

Local **WhatsApp Web** bot that scores each 1:1 DM with **[LightJev](https://github.com/rongxinzy/LightJev)** typed decisions and **archives** high-risk chats.

It does **not** block contacts from the score. It does **not** call Scameter or any phone/URL registry. It does **not** use llama-cpp / GGUF chat.

LightJev returns **uncalibrated candidate probabilities** (boolean `false`/`true` softmax). Treat archives as a review queue, not a verdict. The published 0.6B checkpoint is a synthetic-domain research model, not a general business classifier.

## What it does

1. Reads 1:1 message bodies (including saved contacts).
2. Maps each rubric dimension to a LightJev **boolean** record (`candidates: ["false", "true"]`) with the message as `state`.
3. A local Python worker keeps the checkpoint loaded and scores all questions in one batch (`POST /predict`).
4. Aggregates `P(true)` values into one 0–100 score.
5. **Archives** when the score is at or above the archive threshold, when a tight regex heuristic fires, when the optional local zh/yue classifier is enabled and `prob_scam` is at or above its threshold, or when an **unsaved non-local** number messages you (HK `852` / CN `86` / TW `886` are local; `880–883` and `888` are not treated as China).
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

### Optional local zh/yue classifier

A fine-tuned `hfl/chinese-roberta-wwm-ext` binary (scam / not_scam) can sit **alongside** LightJev and the regex heuristic. It is **opt-in**, **archive-only**, and **fail-open**: if the HTTP scorer is down, times out, or returns junk, the bot ignores it and keeps using LightJev / heuristics / the foreign-number rule.

Weights are **not** in this repo (too large). They live on the GPU PC that trained them, e.g. `C:\Users\Aidan\scam-finetune\model\`.

```bash
# on the GPU machine that has the checkpoint
python -m pip install -r scripts/requirements-classifier.txt
set SCAM_CLASSIFIER_MODEL=C:\Users\Aidan\scam-finetune\model
python scripts/score_server.py
```

Linux/macOS:

```bash
export SCAM_CLASSIFIER_MODEL=/path/to/scam-finetune/model
python scripts/score_server.py
# listens on http://127.0.0.1:8099/v1/score
```

Then on the bot:

```
SCAM_CLASSIFIER_ENABLED=true
SCAM_CLASSIFIER_URL=http://127.0.0.1:8099/v1/score
SCAM_CLASSIFIER_THRESH=0.85
```

If the scorer runs on another host, point `SCAM_CLASSIFIER_URL` at that host (the Node client appends `/v1/score` when you pass a bare origin).

| Variable | Default | Meaning |
|----------|---------|---------|
| `SCAM_CLASSIFIER_ENABLED` | `false` | Opt-in overlay. Unset / `false` / `0` → no HTTP call. |
| `SCAM_CLASSIFIER_URL` | `http://127.0.0.1:8099/v1/score` | POST `{ "text": "..." }`. |
| `SCAM_CLASSIFIER_THRESH` | `0.85` | Archive when `prob_scam` ≥ this. Bot-side; does not trust the worker `label`. |
| `SCAM_CLASSIFIER_TIMEOUT_MS` | `3000` | Fail open on timeout. |
| `SCAM_CLASSIFIER_MODEL` | `scripts/model` | Worker only. Folder with tokenizer + `pytorch_model.bin` / safetensors. |

Only messages with CJK (zh/yue) characters are sent to the model. English-only DMs skip it.

Default **0.85** is higher than the training eval’s 0.5 so a 36-case hard eval’s weaker false positives (e.g. a warning *about* OTP scams at ~0.58) stay below the archive line. Known remaining false positives at this threshold: benign FPS/PayMe bill-split, self-OTP in an official app, and news/chat *about* scams (those sit at ~0.96–0.99). Treat classifier archives as a review queue, same as LightJev.

`npm test` uses an in-process HTTP stub. It does **not** load the RoBERTa weights or need a GPU.

### Scoring knobs (no code change)

See [SCORING_RUBRIC.md](SCORING_RUBRIC.md) and [scoring-rubric.json](scoring-rubric.json).

- `ARCHIVE_THRESHOLD` (default `42`) — label `scam` / archive from score
- `SAFE_THRESHOLD` (default `18`) — label `not_scam`
- `HEURISTIC_ENABLED` (default `true`)
- `STARTUP_FOREIGN_SCAN` (default `true`)
- `SCORE_CACHE_TTL_MS` (default `900000`)
- `RUBRIC_PATH` — override JSON path

If LightJev times out, returns 5xx, or sends invalid JSON, the label is **`unknown`**. Unknown **does not archive** unless the foreign-number rule, heuristic, or (when enabled) the local classifier fires.

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
- `lightjev_serve.py` — persistent checkpoint worker (`POST /predict`)
- `lib/local-classifier-client.js` — optional POST `{text}` to the local RoBERTa scorer
- `scripts/score_server.py` — GPU/CPU worker for the fine-tuned zh/yue classifier
- `stub-lightjev.js` — fixed probabilities for tests and local HTTP stub
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — kept / improved / deferred / rejected

## Disclaimer

This is a personal archive helper. WhatsApp Web automation can violate WhatsApp’s terms and may get the session logged out. Do not use it on other people’s accounts. Scores are **un-calibrated model probabilities** composed with hand-set weights — review every archive before you treat it as a scam.
