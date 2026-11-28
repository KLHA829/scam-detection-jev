# scam-detection-jev verification map

Maintained recipes for operator-facing behavior. Read this index, then the feature file.

Live inbound: structural link check → **mask → LLM** → block policy. jevlike **`POST /v1/score`** is **lab/eval only** — not live archive proof.

## Baseline preconditions

- Repo root for `node --test`.
- `bin/launch-stub` before recipes that need stub HTTP (`mask-before-llm`, `lab-jevlike-score`).
- Default stub base `http://127.0.0.1:18766` (`VERIFY_PORT` to override).
- `bin/doctor` → `worth_driving: yes` before stub HTTP drives.
- Unset threshold/toggle env vars before `node --test` unless a drive script does it for you.
- Do not run `npm start` for these recipes. Do not run `npm audit fix`.

## Driving conventions

- Literal commands from feature files.
- Stub score tags (`[stub:scam]`, etc.) work on `stub-jevlike.js` only.
- `createMaskClient` is the live HTTP client; `SCORER` env does not switch implementations.
- Evidence: `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-<feature-id>/`.
- `bin/cleanup` removes `run/` only.

## Proof and skip reporting

- Capture request/response or TAP plus exit code.
- Record feature id. Skipped paths are not verified.
- Live WhatsApp QR is a separate entry from stub smoke.

## Feature entry contract

Each feature file: H1 + paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-scam-bot`, `Gotchas`.

## Features

- [Mask before LLM](./mask-before-llm.md) — **primary smoke**; typed placeholders over PII spans before any chat API call; incomplete mask skips LLM (fail closed).
- [AGENTS.md invariants](./agents-md-invariants.md) — saved never auto-block; lookalike never auto-blocks; malicious-host block; mask fail-closed; LLM path archives without score auto-block.
- Unreadable sender contact — a DM whose sender contact cannot be read (whatsmeow bridge error, wwebjs throw) is still reviewed with unknown saved status and never auto-archived or blocked; [whatsmeow transport test](../../../../lib/wa-transport/whatsmeow.test.js) (`reviews a DM with unknown saved status when the bridge contact lookup fails`) and [handler tests](../../../../lib/wa-handlers.test.js) (`only alerts when saved status is unknown`).
- [Link lookalike AI review](./link-lookalike-archive.md) — lookalike requires AI confirmation; short links go directly to AI review; no auto-block.
- [Malicious-host block](./malicious-host-block.md) — unsaved auto-block only for URLs on `data/malicious-hosts.json`.
- [LLM review cooldown](./llm-review-cooldown.md) — per-chat skip of mask+LLM after a successful review (link rules still fire).
- Malformed LLM confidence — malformed confidence is rejected and does not archive; [primary review tests](../../../../lib/llm-review-confidence.test.js) and [context review tests](../../../../lib/context-llm-confidence.test.js) cover invalid types and ranges, missing confidence, and valid confidence boundaries.
- [Lab jevlike score](./lab-jevlike-score.md) — **lab-only** stub `/v1/score` and `lab/score-message` tests (not live inbound).
- [Action receipt](./action-receipt.md) — operator self-chat receipt after archive/block.
- [Guided poll](./operator-guided-poll.md) — guided mode waits for 封鎖並封存 / 只封存 / 留低.
- [WhatsApp transport (whatsmeow / Docker)](./wa-transport.md) — Chromium-free `WaTransport` adapter (`WA_TRANSPORT=whatsmeow`, runtime & Docker default; legacy `WA_TRANSPORT=wwebjs` remains optional) and pure-Go `wa-bridge/` sidecar (`/data` state paths in `Dockerfile`); offline tests (`lib/wa-transport/*.test.js`, `wa-bridge/bridge_test.go`) and best-effort `npm run test:e2e:boot:whatsmeow`.

Legacy filename [score-archive.md](./score-archive.md) redirects to mask-primary + lab score docs.
