# Per-chat LLM cooldown

After a successful primary or context LLM review, the same WhatsApp chat does not call the mask worker or the chat API again until **`LLM_REVIEW_COOLDOWN_MS`** (default ten minutes). Link heuristics still archive or block; other messages ignore.

## Sub-features

- `same-chat-skip` — second message in the window skips mask and LLM (`skipped: cooldown`).
- `heuristic-inside-window` — lookalike hard archive still runs without LLM.

## How to get to it (user POV)

- Several plain DMs from one stranger within ten minutes after the bot already reviewed that chat: only the first triggers mask + LLM unless a link rule fires.
- Tune with `LLM_REVIEW_COOLDOWN_MS` in `.env` (see `.env.example`).

## Driving it with verify-scam-bot

Preconditions:

- Repo root. Stub launch is not required.

- **Scripted proof (shared driver).** Run:

```bash
.cursor/skills/verify-scam-detection-jev/bin/drive-llm-review-cooldown
```

Copy or reference the resulting `artifacts/<stamp>-llm-review-cooldown/` under this skill's `evidence/` if you need a single evidence tree for a smoke run.

- **Manual subset.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'processIncomingMessage llm cooldown' \
  lib/llm-review-cooldown.test.js
```

Exit code `0`.

- **Proof.** TAP shows `skips LLM and mask for a second message in the same chat within the window`.

## Gotchas

- Failed mask or LLM does not start the cooldown timer.
- `npm test` sets `LLM_REVIEW_COOLDOWN_MS=0`; the dedicated cooldown tests opt in via in-test `deps.env`.
- Full recipe and sub-features: [verify-scam-detection-jev/features/llm-review-cooldown.md](../verify-scam-detection-jev/features/llm-review-cooldown.md).
