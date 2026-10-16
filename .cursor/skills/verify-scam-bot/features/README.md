# scam-detection-jev verification map

Maintained recipes for operator-facing behavior. Smoke verification uses the stub worker and `node --test`, not WhatsApp Web.

## Baseline preconditions

- Repo root is the working directory.
- Start the stub before recipes that need HTTP: `bin/launch-stub`, then `bin/doctor` → `worth_driving: yes`.
- Default stub base URL: `http://127.0.0.1:18766` (`VERIFY_PORT` to override).
- Unset threshold/toggle env vars before `node --test` unless a recipe sets them explicitly. Drive scripts unset the common keys themselves.
- Do not run `npm start` for these recipes. Do not run `npm audit fix`.

## Driving conventions

- Treat commands as literal.
- Stub tags (`[stub:scam]`) affect **`POST /v1/score` only**; live inbound does not score.
- Save proof under `evidence/<UTC-stamp>-<feature-id>/`.
- `cleanup` removes `run/`; it does not remove `evidence/`.

## Features

- [LLM primary](./llm-primary.md) — mask → LLM archive/ignore; fail closed on mask/LLM failure (**default smoke**).
- [Score archive](./score-archive.md) — **deprecated** (historical jevlike score path).
- [AGENTS.md invariants](./agents-md-invariants.md) — saved never auto-block; lookalike/short-link never auto-block; malicious-host block; LLM/mask fail-closed.
- [Link lookalike archive](./link-lookalike-archive.md) — lookalike or soliciting short link hard-archives; no auto-block.
- [Malicious-host block](./malicious-host-block.md) — unsaved auto-block only for listed hosts.
- [Mask before LLM](./mask-before-llm.md) — `XXX` spans before any chat API; incomplete mask skips the call.
- [Action receipt](./action-receipt.md) — operator self-chat receipt after archive/block.
- [Guided poll](./operator-guided-poll.md) — guided mode poll choices.
