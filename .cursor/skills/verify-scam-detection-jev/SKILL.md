---
name: verify-scam-detection-jev
description: "Drive scam-detection-jev offline the way an operator would: stub jevlike mask worker, in-process DM decisions (handle-incoming), and node:test invariants. Use when proving malicious-host auto-block, link-only archive, mask→LLM fail-closed, or AGENTS.md gates — without WhatsApp QR, Pi, GPU, or live jevlike scam score on inbound."
---

# Verify scam-detection-jev

This skill proves **operator-facing DM policy** for the local WhatsApp Web bot. Live product path (2026-10-17): **link heuristics → mask (`POST /v1/mask`) → primary LLM**; **auto-block only** unsaved contacts on **`data/malicious-hosts.json`**. No live jevlike scam score on inbound (`lab/score-message.js` is eval-only).

**Primary surface:** WhatsApp Web (`npm start` / `whatsapp-bot.js`) — **not required** for verification here.

**Offline driver surfaces:** `stub-jevlike.js` (mask + lab score HTTP), `processIncomingMessage` via `node --test`, and `node scripts/review-eval.js --llm dry --mode triggers`.

Two stub workers can run on different `VERIFY_PORT` values. Two `npm start` processes cannot share `.wwebjs_auth/`. Never start a second WhatsApp client against the operator session.

## Launch

From the repo root, start the offline stub worker (same as `npm run stub`, isolated port):

```bash
.cursor/skills/verify-scam-detection-jev/bin/launch-stub
```

Ready when the script prints `stub listening at http://127.0.0.1:18766/v1/mask` and:

```bash
curl -fsS http://127.0.0.1:18766/health
```

returns `{"ok":true,"model":"stub-jevlike"}`. Log line: `[INFO] stub jevlike listening on http://127.0.0.1:18766/v1/mask (lab /v1/score also served)`. Default port **18766** avoids the operator's `8766` worker. Override with `VERIFY_PORT`.

`launch-stub` reuses a healthy stub whose pid file **this skill** wrote. If the port is taken by another process, it exits without killing it.

Full offline suite (after `npm ci`):

```bash
npm test
```

Optional dry LLM fixture gate (CI also runs this):

```bash
node scripts/review-eval.js --llm dry --mode triggers
```

Live Pi/session path (human QR, not part of default verify):

```bash
# terminal 1 — export JEVLIKE_MASK_CKPT; worker does not read .env
.venv/bin/python jevlike_serve.py
# terminal 2
npm start
```

Stop the smoke stub with **Cleanup** below. Do not delete `.wwebjs_auth/`.

## Doctor

Read-only. Run before every drive that uses the HTTP stub:

```bash
.cursor/skills/verify-scam-detection-jev/bin/doctor
```

`worth_driving: yes` requires:

- Node >= 20 on PATH
- `run/stub.pid` alive and cmdline contains `stub-jevlike.js`
- `GET run/base-url/health` → `"ok":true`, `"model":"stub-jevlike"`

Also prints (informational): `python3`, `node_modules`, r1 checkpoint, PII mask checkpoint.

`worth_driving: no` → run `launch-stub` or fix the printed reason.

Pure `node --test` drives (malicious-host block, lookalike archive, mask fail-closed) do **not** require `worth_driving: yes`, but the full **prove** loop still launches and doctors first.

## Drive

Read `features/README.md`, then one feature file.

**Default scripted proof (malicious-host auto-block, offline):**

```bash
.cursor/skills/verify-scam-detection-jev/bin/drive-malicious-host-block
```

**End-to-end prove loop (launch → doctor → drive → cleanup, keeps artifacts):**

```bash
.cursor/skills/verify-scam-detection-jev/bin/prove-malicious-host-block
```

Other features: exact commands in their feature files (`node --test` subsets, optional `POST /v1/mask` on the launched stub).

Unset env overrides before drives unless a feature file says otherwise: `ARCHIVE_THRESHOLD`, `SAFE_THRESHOLD`, `BLOCK_THRESHOLD`, `BLOCK_ENABLED`, `HEURISTIC_ENABLED`, `OPERATOR_MODE`, `CONTEXT_LLM_ENABLED`, `LLM_REVIEW_ENABLED`, `SCORER`, `MALICIOUS_HOSTS_PATH`.

Do not edit block policy constants in code to make a proof pass.

## Evidence

Each scripted drive writes:

`.cursor/skills/verify-scam-detection-jev/artifacts/<UTC-stamp>-<feature-id>/`

| File | Proves |
|---|---|
| `doctor.txt` | Instance checked before drive (prove loop only) |
| `health.json` | Stub health body (prove loop only) |
| `launch.txt` | Stub listen log excerpt (prove loop only) |
| `node-test.txt` | TAP from named `node --test` cases |
| `summary.json` | `proved: true` when all required tests passed |

Proof standard: exercise **production decision code** (`processIncomingMessage`, `applyBlockPolicy`, link rules) via tests and, when used, the **same HTTP mask contract** the bot calls. Capture exit codes and TAP lines, not only `summary.json`. Stub/`node --test` does not send WhatsApp messages.

## Cleanup

```bash
.cursor/skills/verify-scam-detection-jev/bin/cleanup
```

Sends SIGTERM only to the pid in `run/stub.pid` when cmdline contains `stub-jevlike.js`, then removes `run/`. **Does not delete `artifacts/`.** Does not kill by process name; does not touch `.wwebjs_auth/`, `blocks.jsonl`, or operator JSON state.

After cleanup, `doctor` must print `worth_driving: no`. Evidence from the drive must still exist.

## Helpers

| Helper | Invocation |
|---|---|
| Start stub | `.cursor/skills/verify-scam-detection-jev/bin/launch-stub` |
| Doctor | `.cursor/skills/verify-scam-detection-jev/bin/doctor` |
| Malicious-host block proof | `.cursor/skills/verify-scam-detection-jev/bin/drive-malicious-host-block` |
| Full prove loop | `.cursor/skills/verify-scam-detection-jev/bin/prove-malicious-host-block` |
| Stop stub, keep artifacts | `.cursor/skills/verify-scam-detection-jev/bin/cleanup` |

## Maintenance

When operator-facing behavior changes, update `features/` with `/maintain-verification-skill` rather than inventing a second harness.
