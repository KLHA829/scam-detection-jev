# scam-detection-jev verification map

Maintained source for verifying **offline** operator policy (no WhatsApp QR). Read this index, then the feature file for the journey you need.

## Baseline preconditions

- Repo root is the working directory; `npm ci` done if running tests that load `whatsapp-web.js`.
- For HTTP mask checks: stub at `http://127.0.0.1:18766` via `bin/launch-stub` (or `VERIFY_PORT`).
- Unset threshold/toggle env vars listed in `SKILL.md` unless a feature file overrides.
- Never drive a stub pid this skill did not start when `doctor` must pass.

## Driving conventions

- Prefer scripted helpers under `bin/`; manual commands in feature files are literal.
- Proof artifacts go under `.cursor/skills/verify-scam-detection-jev/artifacts/<UTC-stamp>-<feature-id>/`.
- Cleanup removes `run/` only; artifacts survive.

## Proof and skip reporting

- Capture TAP / HTTP bodies and exit codes, not only a success banner.
- A skipped entry point is not proved by a different feature.
- Live WhatsApp archive/block on a real chat requires `npm start` + QR — out of scope for default verify.

## Feature entry contract

Each feature file: H1 title, one intro paragraph, then exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-scam-detection-jev`, `Gotchas`.

## Features

- [Malicious-host auto-block](./malicious-host-block.md) — unsaved + listed URL → block `封鎖·惡意域名`.
- [Link heuristic archive only](./link-heuristic-archive.md) — lookalike / soliciting short link → archive, no auto-block.
- [Mask then LLM (fail closed)](./mask-llm-primary.md) — mask failure skips LLM and does not archive.
- [Per-chat LLM cooldown](./llm-review-cooldown.md) — same chat skips mask + LLM for 10 min after a successful review.
- [Benign DM ignore](./benign-ignore.md) — plain chat stays ignore without block/archive.
- [AGENTS.md invariants](./agents-invariants.md) — saved never block, score alone never block, dual-hit host order.
