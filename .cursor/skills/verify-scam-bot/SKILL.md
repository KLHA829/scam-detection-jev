---
name: verify-scam-bot
description: "Drive the local WhatsApp scam-DM bot (scam-detection-jev) the way an operator would. Smoke proof uses the stub jevlike HTTP worker (GET /health, POST /v1/mask; POST /v1/score is lab-only) and offline node:test subsets. Use when proving mask-before-LLM, AGENTS.md block/archive invariants, masked review of link-rule hits, malicious-host auto-block, action receipts, LLM cooldown, or the guided self-chat poll. Live WhatsApp Web QR is a separate session and is not required."
---

# Verify scam-detection-jev

This skill proves operator-facing behavior of the local WhatsApp scam-DM bot. **Live inbound DMs:** only curated URL or email-domain matches in `data/malicious-hosts.json` can archive without masked AI review, subject to the warning-only exception. Lookalike and soliciting short-link hits go through **mask (`POST /v1/mask`) → OpenAI-compatible LLM** and get an archive recommendation only when AI confirms scam. Saved contacts get a self-chat review card for any recommendation instead of an automatic archive or block. **Auto-block** applies only to unsaved contacts with a curated URL match, never to email-domain matches or model verdicts. jevlike `/v1/score` is lab-only.

Smoke verification does not open Chrome or WhatsApp. It starts `stub-jevlike.js` (same as `npm run stub`) on `127.0.0.1:18766` and runs `node --test` cases that call `processIncomingMessage`. Live WhatsApp (`npm start`) needs a human QR scan and `.wwebjs_auth/`. Do not start it for smoke proof.

**Full Autopilot** (goal → split → self-prove → PR): [full-autopilot](../full-autopilot/SKILL.md). Use this skill for `doctor` / `drive-*` / gardener encoding inside that loop.

Two stub workers can run on different `VERIFY_PORT` values. Two `npm start` processes cannot share `.wwebjs_auth/`.

## Launch

From the repo root:

```bash
.cursor/skills/verify-scam-bot/bin/launch-stub
```

Ready when `GET http://127.0.0.1:18766/health` returns `{"ok":true,"model":"stub-jevlike"}`. Override port with `VERIFY_PORT`. Default `18766` avoids the bot's `JEVLIKE_PORT` / `8766`.

Full offline suite (after `npm ci`):

```bash
npm test
```

Live worker (human QR path only): export `JEVLIKE_MASK_CKPT` for `POST /v1/mask`. `jevlike_serve.py` does not read `.env`.

Stop the smoke stub with cleanup below. Do not delete `.wwebjs_auth/`.

## Doctor

Run before every stub HTTP drive:

```bash
.cursor/skills/verify-scam-bot/bin/doctor
```

`worth_driving: yes` means Node on PATH, `run/stub.pid` is `stub-jevlike.js`, and `GET …/health` is `{ok:true, model:stub-jevlike}`.

Also prints (non-fatal): `python3`, `node_modules`, gitignored `checkpoint` / `pii_mask` presence.

`worth_driving: no` → launch stub or fix the printed reason.

## Drive

Read `features/README.md`, then the feature file.

**Primary smoke (mask → LLM era):**

```bash
.cursor/skills/verify-scam-bot/bin/drive-mask-before-llm
```

Requires doctor. Exercises stub `POST /v1/mask` and a `node --test` subset for masked LLM archive and mask fail-closed behavior. See `features/mask-before-llm.md`.

**Offline invariant drives (no stub required):**

```bash
.cursor/skills/verify-scam-bot/bin/drive-agents-invariants
.cursor/skills/verify-scam-bot/bin/drive-malicious-host-block
.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown
```

**Lab-only** (stub `POST /v1/score` + `lab/score-message` tests — not live inbound proof):

```bash
.cursor/skills/verify-scam-bot/bin/drive-score-archive
```

See `features/lab-jevlike-score.md`. Historical `evidence/*-score-archive/` folders predate the mask-primary product.

Other features use the `node --test` / `curl` commands in their feature files.

Do not point smoke drives at live `jevlike_serve.py`. Doctor rejects health whose `model` is not `stub-jevlike`.

## Mini-WhatsApp real-mask validation

Use this only when proving a real PII-mask checkpoint end to end; it is not a replacement for the offline stub smoke above.

1. Start the real worker separately with the checkpoint under test, for example `JEVLIKE_MASK_CKPT=/path/to/jevlike_hf_pii_mask.pt .venv/bin/python jevlike_serve.py`. Confirm the worker log names that checkpoint before driving traffic.
2. Start Mini-WhatsApp with `node scripts/mini-whatsapp.js --with-bot` and **without** `--with-stub`; otherwise the harness replaces the real worker. Inherit or export `JEVLIKE_BASE_URL` so the bot points at the real worker. `--with-stub` is only for offline UI testing.
3. `scripts/mini-whatsapp.js`'s exported `startMockLlmServer` does not log requests. When proving no raw PII reached the LLM, use a temporary local logging mock Chat Completions server and inspect its JSONL/request log.
4. Desktop keyboard typing can drop Cantonese or other Unicode characters in the Mini-WhatsApp textarea. Send exact Unicode fixtures through the sanctioned local `/api/inbound` endpoint, then use the Web UI for chat selection and visual/archive assertions.
5. For long-message mask probes, inspect HF tokenizer windows (`context_tokens` plus `stride`) rather than assuming character count equals token count. Record enough state/log evidence to show which checkpoint, masked transcript, LLM requests, and archive states were observed.

**Windows:** `bin/launch-stub`, `bin/doctor`, and `bin/cleanup` are bash scripts — run them from Git Bash (or ensure `VERIFY_BASH` points at `Git\bin\bash.exe`). Node `bin/drive-*` that call doctor resolve Git Bash themselves and skip the broken Store/WSL `bash` stub on PATH. `bin/launch-stub` starts the stub via `bin/_start-stub-process.js` (records the real node pid). Pid ownership uses `bin/_stub-pid-looks-like.js` (Win32: child-tree walk + recorded pid + `/health` when cmdline is opaque).

**CI:** `.github/workflows/test.yml` runs `node scripts/ci-static-gates.js`, then `scripts/ci-verify-smoke.sh` on Ubuntu and Windows (same drive sequence as above; uploads `evidence/` artifacts).

Thresholds and toggles change through `scoring-rubric.json` and env — not hard-coded constants in code.

## Evidence

Each scripted drive writes:

`.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-<feature-id>/`

Mask-before-llm includes `doctor.txt`, `health.json`, `mask.json`, `node-test.txt`, `summary.json` (`proved: true` only when HTTP and every named test pass).

For manual drives, save command, stdout/stderr, exit code, and feature id under the same tree.

Proof standard: exercise the stub HTTP contract the bot uses for mask (and lab score when labelled lab-only), plus `processIncomingMessage` tests for archive/block decisions. Stub runs do not prove a real WhatsApp chat was archived.

## Cleanup

```bash
.cursor/skills/verify-scam-bot/bin/cleanup
```

SIGTERM to `run/stub.pid` when cmdline contains `stub-jevlike.js`, then removes `run/`. Does not delete `evidence/` or `.wwebjs_auth/`.

## Helpers

| Helper | Invocation |
|---|---|
| Start stub | `.cursor/skills/verify-scam-bot/bin/launch-stub` |
| Read-only health | `.cursor/skills/verify-scam-bot/bin/doctor` |
| **Primary smoke** | `.cursor/skills/verify-scam-bot/bin/drive-mask-before-llm` |
| AGENTS.md invariants | `.cursor/skills/verify-scam-bot/bin/drive-agents-invariants` |
| Malicious-host block | `.cursor/skills/verify-scam-bot/bin/drive-malicious-host-block` |
| LLM per-chat cooldown | `.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown` |
| Lab jevlike score only | `.cursor/skills/verify-scam-bot/bin/drive-score-archive` |
| Stop stub | `.cursor/skills/verify-scam-bot/bin/cleanup` |

## Maintenance

When operator-facing behavior changes, update this skill and `features/` with `/maintain-verification-skill` — do not add a second harness.

**Gardener checklist (encode fixes, not only prose):**

1. **Reproduce** — `bin/doctor` (if stub HTTP) and the failing `bin/drive-*` or `npm test` case.
2. **Fix** — product code or docs; keep AGENTS.md invariants.
3. **Encode** — add or extend a `lib/*.test.js` lock, a feature map entry under `features/`, and the matching `bin/drive-*` test-name list when the smoke path changes.
4. **Prove** — re-run the drive; commit fresh `evidence/` only when a human explicitly wants a snapshot (gitignored or committed per team habit).

Corrections belong in **tests, CI, skill drivers, or structure** — not only AGENTS.md paragraphs. See AGENTS.md gardener note.

**Alias:** `.cursor/skills/verify-scam-detection-jev/` redirects here (thin `bin/` shims only). Do not maintain a second feature map there.
