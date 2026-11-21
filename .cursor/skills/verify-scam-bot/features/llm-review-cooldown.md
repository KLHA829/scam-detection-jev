# Per-chat LLM cooldown

After a successful primary or context LLM review archives a chat, that WhatsApp chat skips mask and LLM until **`LLM_REVIEW_COOLDOWN_MS`** (default ten minutes). Benign or low-confidence reviews do not start the cooldown, so a follow-up message is reviewed. The window survives a bot restart via **`llm-review-cooldown.json`** (`LLM_REVIEW_COOLDOWN_PATH` optional). Link heuristics still archive or block.

## Sub-features

- `same-chat-skip` — after an LLM archive, a second message in the window → `skipped: cooldown`.
- `persist-restart` — file-backed store reloads on `npm start` until expiry.
- `heuristic-inside-window` — lookalike hard archive without LLM.

## How to get to it (user POV)

- Several DMs from one stranger within ten minutes after an LLM archive: only the first triggers mask + LLM unless a link rule fires. A benign opener does not suppress review of the next message.
- Restart the bot mid-window: the same chat stays suppressed until expiry.
- Tune with `LLM_REVIEW_COOLDOWN_MS` in `.env`.

## Driving it with verify-scam-bot

Preconditions: repo root; stub not required.

```bash
.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown
```

Or manually:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'processIncomingMessage llm cooldown' \
  lib/llm-review-cooldown.test.js
```

Save TAP under `evidence/<UTC-stamp>-llm-review-cooldown/`.

## Gotchas

- Failed mask or LLM, or a successful review that does not archive, does not start the cooldown timer.
- `npm test` sets `LLM_REVIEW_COOLDOWN_MS=0`; cooldown tests opt in via in-test `deps.env`.
- Tests inject an in-memory store; production uses the file-backed store from `whatsapp-bot.js`.
