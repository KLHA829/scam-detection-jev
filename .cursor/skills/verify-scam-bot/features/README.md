# scam-detection-jev verification map

This directory is the maintained source for verifying operator-facing behavior of the local WhatsApp scam-DM bot. Read this index, then use the matching feature file as the recipe.

The operator touches WhatsApp: incoming 1:1 DMs, and their own chat for the setup poll, the guided poll, and the archive/block receipt. Smoke verification does not open that session. It uses the stub worker and `node --test`.

## Baseline preconditions

- Repo root is the working directory for `node --test` commands.
- Start the stub with `.cursor/skills/verify-scam-bot/bin/launch-stub` before any recipe that says the stub must be healthy.
- Default stub base URL is `http://127.0.0.1:18766`. Set `VERIFY_PORT` before launch to run a second stub.
- `.cursor/skills/verify-scam-bot/bin/doctor` prints `worth_driving: yes` before a stub HTTP drive.
- Unset `ARCHIVE_THRESHOLD`, `SAFE_THRESHOLD`, `BLOCK_THRESHOLD`, `BLOCK_ENABLED`, `HEURISTIC_ENABLED`, `OPERATOR_MODE`, `CONTEXT_LLM_ENABLED`, `LLM_REVIEW_ENABLED`, and `SCORER` before `node --test` recipes. `drive-score-archive` does this itself. Committed lines are archive 42, safe 18, block 80 in `scoring-rubric.json`.
- Do not run `npm start` for these recipes. One `.wwebjs_auth/` session is the operator's. Do not run `npm audit fix`.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal.
- Stub score tags (`[stub:scam]`, `[stub:benign]`, `[stub:high]`, `[stub:grey]`) work on `stub-jevlike.js` only.
- The only scorer is HF jevlike. `SCORER=model_v2` still constructs a `JevlikeClient`.
- Save proof under `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-<feature-id>/`.
- Cleanup removes `run/` and the stub pid. It does not remove `evidence/`.

## Proof and skip reporting

- Capture the request or test command and the resulting decision, not only a process exit code.
- HTTP proof includes the JSON request and the JSON response.
- `node --test` proof includes TAP (or spec) stdout and the exit code.
- Record the feature id. A path you did not run is not verified.
- Live WhatsApp proof, if a human has scanned the QR, is a separate entry. `[OK] WhatsApp client ready` plus a real DM is that entry. A stub run does not prove a chat was archived in WhatsApp.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-scam-bot`, `Gotchas`.

## Features

- [Score archive](./score-archive.md) — a jevlike score at the archive line archives; a score alone does not block; a failed score does not archive.
- [AGENTS.md invariants](./agents-md-invariants.md) — saved never auto-block; lookalike/short-link never auto-block; malicious-host block; score alone never block; scorer unknown does not archive alone.
- [Link lookalike archive](./link-lookalike-archive.md) — lookalike or soliciting short link hard-archives; no auto-block.
- [Malicious-host block](./malicious-host-block.md) — unsaved auto-block only for URLs on `data/malicious-hosts.json`.
- [Mask before LLM](./mask-before-llm.md) — personal-data spans become `XXX` before any chat API call; an incomplete mask skips the call.
- [Action receipt](./action-receipt.md) — the operator's own chat gets the chat-list name, phone, and local reason after archive or block.
- [Guided poll](./operator-guided-poll.md) — guided mode waits for 封鎖並封存, 只封存, or 留低.
