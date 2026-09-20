# scam-detection-jev

Local **WhatsApp Web** bot that scores each 1:1 DM with a **Jev-compatible OpenJEV** typed-decision API (`POST /v1/systemone`) and **archives** high-risk chats.

It does **not** block contacts from the score. It does **not** call Scameter or any phone/URL registry. It does **not** download a local GGUF / Qwen model.

OpenJEV (and hosted Jev) return **probabilities**, not calibrated risk percentages. Treat archives as a review queue, not a verdict.

## What it does

1. Reads 1:1 message bodies (including saved contacts).
2. Sends the text as `state` to OpenJEV with a multi-axis rubric (money, banking, login/OTP, impersonation, …).
3. Aggregates dimension probabilities into one 0–100 score.
4. **Archives** when the score is at or above the archive threshold, when a zh/yue heuristic fires, when offline RAG matches a known scam template, or when an **unsaved non-local** number messages you (HK `852` / CN `86` / TW `886` are local; `880–883` and `888` are not treated as China).
5. Optional startup pass: first **10** sidebar 1:1 chats, **foreign-number archive only** (no scoring).

Filters drop `fromMe`, groups, notification types, your own account, and official WhatsApp names. `@lid` chats are resolved to a real number before the foreign-number rule; LID digits are never used as a phone.

## Setup

Requires **Node.js 20+** and a WhatsApp account you are allowed to link via WhatsApp Web.

```bash
cp .env.example .env
# set OPENJEV_API_KEY (and OPENJEV_BASE_URL if you are not using the default)
npm install
npm start
```

Scan the QR code. Session files stay in `.wwebjs_auth/` (gitignored).

### OpenJEV / Jev

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPENJEV_BASE_URL` | `https://api.typesafe.ai` | API root. Client posts to `{base}/v1/systemone`. Self-hosted OpenJEV: `http://127.0.0.1:8000`. |
| `OPENJEV_API_KEY` | _(empty)_ | Bearer token. Optional for some local servers. Alias: `TYPESAFE_API_KEY`. |
| `OPENJEV_MODEL` | `jev-latest` | Model id sent in the JSON body. |
| `OPENJEV_TIMEOUT_MS` | `8000` | Per-attempt timeout. |

Aliases: `TYPESAFE_BASE_URL`, `TYPESAFE_API_KEY`.

For offline development without a live model:

```bash
npm run stub
# OPENJEV_BASE_URL=http://127.0.0.1:8765 OPENJEV_API_KEY=local npm start
```

Include `[stub:scam]` in a message body to force the stub’s high-risk preset.

### Scoring knobs (no code change)

See [SCORING_RUBRIC.md](SCORING_RUBRIC.md) and [scoring-rubric.json](scoring-rubric.json).

- `ARCHIVE_THRESHOLD` (default `42`) — label `scam` / archive from score
- `SAFE_THRESHOLD` (default `18`) — label `not_scam`
- `HEURISTIC_ENABLED` (default `true`)
- `RAG_ENABLED` (default `true`)
- `RAG_THRESHOLD` (default `0.35`)
- `RAG_CORPUS_PATH` (default `data/scam-examples-zh-yue.jsonl`)
- `STARTUP_FOREIGN_SCAN` (default `true`)
- `SCORE_CACHE_TTL_MS` (default `900000`)
- `RUBRIC_PATH` — override JSON path

If OpenJEV times out, returns 5xx, or sends invalid JSON, the label is **`unknown`**. Unknown **does not archive** unless the foreign-number rule, heuristic, or RAG template match fires.

## Chinese / Cantonese backup (not a LightJev fine-tune)

The offline stub still ignores message language unless `[stub:scam]` is present, so Mandarin / Cantonese copy would otherwise score `0`. This repo does **not** fine-tune LightJev / OpenJEV weights and does **not** download multi-GB models. Live OpenJEV remains optional.

Two **local, offline, archive-only** backups (never block contacts):

1. **Heuristics** (`lib/heuristics.js`) — HK/CN tropes including OTP / 验证码 / 转移代码 harvest; 轉數快 / 转数快 / FPS urgent money; fake 公安 / 警察 / 海关 / 入境处 / 银行; USDT + 钱包 + 打到 / 转; 清关 / 关税 / 包裹 + pay or link; WhatsApp code forwarding; job 保证金; secrecy (`不要告诉别人` / `唔好同任何人講`) with money or OTP.
2. **Lightweight RAG** (`lib/rag.js`) — loads the shipped JSONL corpus, folds Traditional/Simplified characters, and scores token Jaccard + character trigram overlap. A hit archives as `rag_scam_match` with the matched example id. Strong tag overlap (for example OTP + FPS) can also fire when lexical similarity is a bit below the threshold.

The corpus (`data/scam-examples-zh-yue.jsonl`) is **paraphrased** from public HK/CN police and ADCC-style advisories, not verbatim victim messages. Sources: [data/DATA.md](data/DATA.md). RAG does not use the network at runtime.

Disable with `HEURISTIC_ENABLED=false` and/or `RAG_ENABLED=false`.

## Tests

`npm test` is **offline**: in-process stub probabilities, no live WhatsApp, no live OpenJEV.

```bash
npm test
```

## Docker (optional)

No model weights are downloaded. Chromium is used for WhatsApp Web.

```bash
docker build -t scam-detection-jev .
docker run --rm -it \
  -e OPENJEV_BASE_URL \
  -e OPENJEV_API_KEY \
  -v "$(pwd)/.wwebjs_auth:/app/.wwebjs_auth" \
  scam-detection-jev
```

QR login still needs a terminal that can show the code (or inspect container logs).

## Layout

- `whatsapp-bot.js` — WhatsApp Web client, QR, archive-only actions
- `lib/` — OpenJEV client, scoring, foreign-number, LID, filters, heuristics, zh/yue RAG, decide matrix
- `data/scam-examples-zh-yue.jsonl` — offline paraphrased HK/CN scam templates
- `stub-openjev.js` — fixed probabilities for tests and local HTTP stub
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — kept / improved / deferred / rejected

## Disclaimer

This is a personal archive helper. WhatsApp Web automation can violate WhatsApp’s terms and may get the session logged out. Do not use it on other people’s accounts. Scores are **un-calibrated model probabilities** composed with hand-set weights — review every archive before you treat it as a scam.
