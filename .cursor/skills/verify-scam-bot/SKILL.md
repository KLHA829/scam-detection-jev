---
name: verify-scam-bot
description: "Drive the local WhatsApp scam-DM bot (scam-detection-jev) the way an operator would. Smoke proof uses the stub jevlike HTTP worker (GET /health, POST /v1/score, POST /v1/mask) and the offline node:test subset. Use when proving score archive, link-rule block, mask-before-LLM, action receipts, or the guided self-chat poll. Live WhatsApp Web QR is a separate session and is not required."
---

# Verify scam-detection-jev

This skill proves the operator-facing behavior of the local WhatsApp scam-DM bot. The bot scores each 1:1 DM with HF-encoder jevlike, archives from the score, blocks an unsaved contact only on a current-message link rule or an explicit context-model `block`, and can ask the operator in their own chat before acting.

The smoke path does not open Chrome or WhatsApp. It starts `stub-jevlike.js` (the same process as `npm run stub`) on `127.0.0.1:18766` and runs the `node --test` cases that call `processIncomingMessage`, which is the function the bot uses for each DM. Live WhatsApp (`npm start`) needs a human QR scan and one `.wwebjs_auth/` session. Do not start it for a smoke proof.

Two stub workers can run side by side on different `VERIFY_PORT` values. Two `npm start` processes cannot: they share `.wwebjs_auth/`. Never start a second WhatsApp client against that directory.

## Launch

From the repo root, start only the stub worker:

```bash
.cursor/skills/verify-scam-bot/bin/launch-stub
```

Ready when the script prints `stub listening at http://127.0.0.1:18766/v1/score` and `GET http://127.0.0.1:18766/health` returns `{"ok":true,"model":"stub-jevlike"}`. The process log line is `[INFO] stub jevlike listening on http://127.0.0.1:18766/v1/score`. Override the port with `VERIFY_PORT` before launch. The default `18766` stays off the bot's `JEVLIKE_PORT` / `8766` so a real worker the operator already started is left alone.

`launch-stub` reuses a healthy stub whose pid file this skill wrote. If the port is taken by any other process, it exits and does not kill that process.

Full offline suite, after `npm ci` because `lib/wa-handlers.test.js` loads `whatsapp-web.js`:

```bash
npm test
```

That runs `node --test` and `python3 -m unittest test_jevlike_serve.py`. It does not download the encoder and does not open WhatsApp. `PUPPETEER_SKIP_DOWNLOAD=true` is what CI sets; the tests do not launch Chrome.

Live operator session, only when a human can scan the QR. Weights must exist at `models/jevlike_hf_chinese_roberta_r1.pt` (see `scripts/download_jevlike_ckpt.sh`). `jevlike_serve.py` does not read `.env`; export `JEVLIKE_CKPT` in the worker's own environment.

```bash
# terminal 1
.venv/bin/python jevlike_serve.py
# ready: [INFO] jevlike worker listening on http://127.0.0.1:8766/v1/score
# GET /health has "model":"jevlike" and "ok":true

# terminal 2
npm start
# QR: [INFO] scan QR to link WhatsApp Web
# session: [OK] WhatsApp session authenticated
# ready: [OK] WhatsApp client ready
```

Stop the smoke stub with the cleanup command below. Stop a live bot by ending the `npm start` process you started. Do not delete `.wwebjs_auth/`.

## Doctor

Run this before every drive. It is read-only.

```bash
.cursor/skills/verify-scam-bot/bin/doctor
```

`worth_driving: yes` means all of the following:

- `node` is on PATH (this repo requires Node >= 20).
- `run/stub.pid` is alive and its command line contains `stub-jevlike.js`.
- `GET` of `run/base-url` + `/health` returns `"ok":true` and `"model":"stub-jevlike"`.

It also prints, without failing the smoke path:

- `python3` — required for the `npm test` Python half and for `jevlike_serve.py`.
- `node_modules: absent` — `npm ci` before `npm test` or `npm start`. The score-archive `node --test` subset does not import `whatsapp-web.js`.
- `checkpoint: absent` — the r1 head is gitignored. The stub proof does not need it. `jevlike_serve.py` exits on startup without `models/jevlike_hf_chinese_roberta_r1.pt`.
- `pii_mask: absent` — live `POST /v1/mask` returns 503 until `models/jevlike_hf_pii_mask.pt` is loaded. The stub still answers `/v1/mask` with the offline span helper.

`worth_driving: no` means do not drive. Launch first, or fix the reason it prints.

## Drive

Read `features/README.md`, then the feature file. Run one feature from a clean stub. The scripted smoke feature is score archive:

```bash
.cursor/skills/verify-scam-bot/bin/drive-score-archive
```

That helper:

1. Requires a passing doctor.
2. `POST /v1/score` with `{"text":"[stub:scam] 請立即轉帳"}`. The stub preset `scam` is score 96, label `scam` (archive line is 42).
3. `POST /v1/score` with `{"text":"今晚飲茶？"}`. The default preset `benign` is score 4, label `not_scam` (safe line is 18).
4. Runs the `node --test --test-reporter tap` subset named in `features/score-archive.md`. It unsets `ARCHIVE_THRESHOLD`, `SAFE_THRESHOLD`, `BLOCK_THRESHOLD`, `BLOCK_ENABLED`, `HEURISTIC_ENABLED`, `OPERATOR_MODE`, `CONTEXT_LLM_ENABLED`, `LLM_REVIEW_ENABLED`, and `SCORER` so the committed `scoring-rubric.json` lines (archive 42, safe 18, block 80) are what the tests see.

A `[stub:scam]` tag is honored only by `stub-jevlike.js`. The real worker scores the words.

Other features are driven with the `node --test` commands in their feature files. They use the in-process stub client and do not need the HTTP worker, except the mask feature's `POST /v1/mask` check, which uses the same launched stub.

Do not point this smoke drive at a live `jevlike_serve.py`. Doctor rejects a health body whose `model` is not `stub-jevlike`.

Thresholds and toggles change through `scoring-rubric.json` and env (`ARCHIVE_THRESHOLD`, `SAFE_THRESHOLD`, `BLOCK_THRESHOLD`, `BLOCK_ENABLED`, `HEURISTIC_ENABLED`, `OPERATOR_MODE`, `CONTEXT_LLM_ENABLED`). Do not edit numeric constants in code to make a proof pass.

## Evidence

Each scripted drive writes a new directory:

`.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-<feature-id>/`

Score-archive contents:

| File | What it proves |
|---|---|
| `doctor.txt` | The instance that was driven |
| `health.json` | `GET /health` body |
| `launch.txt` | Stub startup log, including the listen line. Named `.txt` so the repo's `*.log` gitignore does not drop it. |
| `score-scam.request.json` / `score-scam.json` | The scored body and the HTTP response |
| `score-benign.request.json` / `score-benign.json` | The safe body and the HTTP response |
| `node-test.txt` | TAP from the decision tests, including commands' exit status via `# fail` |
| `summary.json` | `proved: true` only when both HTTP checks and every named test passed |

For a feature you drive by hand, create `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-<feature-id>/` and save the command, stdout, stderr, and exit code. Record the feature id from the feature file. A skipped entry point is not proved by a different feature.

Proof standard: exercise the stub HTTP contract the bot posts, and the `processIncomingMessage` tests that perform archive and block through callbacks. Capture the request and the resulting score or decision, not only a final status line. `npm test` and the stub are the production boundary for offline proof. They do not send WhatsApp messages. A live QR session is the only path that archives or blocks a real chat; do not claim that from a stub run.

## Cleanup

```bash
.cursor/skills/verify-scam-bot/bin/cleanup
```

This sends SIGTERM to the pid in `run/stub.pid` only when that process command line contains `stub-jevlike.js`, then deletes `.cursor/skills/verify-scam-bot/run/`. It does not delete `.cursor/skills/verify-scam-bot/evidence/`. It does not kill by process name, and it does not remove `.wwebjs_auth/`, `blocks.jsonl`, `operator-mode.json`, or `review-queue.json`.

After cleanup, `doctor` must print `worth_driving: no`. The evidence directory from the drive must still be on disk.

## Helpers

All paths are from the repo root. Each helper is executable.

| Helper | Invocation |
|---|---|
| Start stub | `.cursor/skills/verify-scam-bot/bin/launch-stub` |
| Read-only health | `.cursor/skills/verify-scam-bot/bin/doctor` |
| Score-archive proof | `.cursor/skills/verify-scam-bot/bin/drive-score-archive` |
| Stop stub, keep evidence | `.cursor/skills/verify-scam-bot/bin/cleanup` |

`drive-score-archive` is the only feature with a helper. The other feature files carry their own `node --test` and `curl` commands.

## Maintenance

When the bot's operator-facing behavior changes, update this map with `/maintain-verification-skill` rather than inventing a second harness.
