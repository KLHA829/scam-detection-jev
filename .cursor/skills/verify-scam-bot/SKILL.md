---
name: verify-scam-bot
description: "Drive the local WhatsApp scam-DM bot (scam-detection-jev) the way an operator would. Smoke proof uses the stub jevlike HTTP worker (GET /health, POST /v1/mask; POST /v1/score lab-only) and offline node:test. Use when proving mask→LLM primary archive, AGENTS.md block/archive invariants, link-rule archive (no auto-block), malicious-host auto-block, mask-before-LLM fail-closed, action receipts, or the guided self-chat poll. Live WhatsApp Web QR is a separate session and is not required."
---

# Verify scam-detection-jev

This skill proves operator-facing behavior of the local WhatsApp scam-DM bot. **Live path (2026-10-16):** mask PII locally (`POST /v1/mask`), then **required** OpenAI-compatible LLM judgment for non-heuristic DMs. Link rules (lookalike, soliciting short link) hard-archive without the LLM. **Auto-block** is unsaved contacts only when the current message URL matches `data/malicious-hosts.json`. Models do not auto-block.

The smoke path does not open Chrome or WhatsApp. It starts `stub-jevlike.js` on `127.0.0.1:18766` and runs `node --test` cases that call `processIncomingMessage`. Live WhatsApp (`npm start`) needs a human QR scan. Do not start it for smoke proof.

Two stub workers can run on different `VERIFY_PORT` values. Two `npm start` processes cannot share `.wwebjs_auth/`.

## Launch

From the repo root:

```bash
.cursor/skills/verify-scam-bot/bin/launch-stub
```

Ready when `GET http://127.0.0.1:18766/health` returns `{"ok":true,"model":"stub-jevlike"}`. Override port with `VERIFY_PORT`.

Full offline suite (after `npm ci`):

```bash
npm test
```

Live session: export `JEVLIKE_MASK_CKPT` for the worker, set `LLM_REVIEW_*`, then `jevlike_serve.py` + `npm start`. The scam scorer checkpoint is optional (lab `/v1/score` only).

## Doctor

```bash
.cursor/skills/verify-scam-bot/bin/doctor
```

`worth_driving: yes` when the skill's stub pid is alive and health returns `stub-jevlike`.

## Drive

Read `features/README.md`, then the feature file. **Primary smoke feature:**

```bash
.cursor/skills/verify-scam-bot/bin/drive-llm-primary
```

That helper:

1. Requires a passing doctor.
2. `POST /v1/mask` with a PII sample (non-empty spans) and with benign text (empty spans).
3. Runs the `node --test` subset named in `features/llm-primary.md`.

`drive-score-archive` is a **deprecated alias** for `drive-llm-primary`.

Other scripted drives:

```bash
.cursor/skills/verify-scam-bot/bin/drive-agents-invariants
.cursor/skills/verify-scam-bot/bin/drive-malicious-host-block
```

AGENTS.md invariants and malicious-host block are offline `node --test` only (no stub HTTP required).

Do not point smoke drives at live `jevlike_serve.py`. Doctor expects `model: stub-jevlike`.

Thresholds and toggles change through `scoring-rubric.json` and env. Do not edit numeric constants in code to make proof pass.

## Evidence

Each scripted drive writes:

`.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-<feature-id>/`

LLM-primary contents include `doctor.txt`, `health.json`, `mask.json`, `mask-empty.json`, `node-test.txt`, `summary.json` (`proved: true` when HTTP + tests pass).

Proof standard: stub HTTP contract the bot uses for mask, plus `processIncomingMessage` tests with mocked LLM `fetchImpl`. Stub runs do not archive real WhatsApp chats.

## Cleanup

```bash
.cursor/skills/verify-scam-bot/bin/cleanup
```

Stops the skill stub pid only; keeps `evidence/`.

## Helpers

| Helper | Invocation |
|---|---|
| Start stub | `.cursor/skills/verify-scam-bot/bin/launch-stub` |
| Read-only health | `.cursor/skills/verify-scam-bot/bin/doctor` |
| **LLM primary proof** | `.cursor/skills/verify-scam-bot/bin/drive-llm-primary` |
| Score archive (deprecated) | `.cursor/skills/verify-scam-bot/bin/drive-score-archive` |
| AGENTS.md invariants | `.cursor/skills/verify-scam-bot/bin/drive-agents-invariants` |
| Malicious-host block | `.cursor/skills/verify-scam-bot/bin/drive-malicious-host-block` |
| Stop stub | `.cursor/skills/verify-scam-bot/bin/cleanup` |

## Maintenance

When operator-facing behavior changes, update this map with `/maintain-verification-skill` rather than inventing a second harness. Sync feature files, drive scripts' `TEST_NAMES`, and (when behavior shifts) refresh evidence with a new stamped run.
