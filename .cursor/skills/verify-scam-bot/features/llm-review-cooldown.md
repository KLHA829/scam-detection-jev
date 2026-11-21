# Per-chat LLM cooldown

In automatic mode, a successful primary or context LLM review starts the per-chat **`LLM_REVIEW_COOLDOWN_MS`** window (default ten minutes) only after the chat is archived. That chat skips mask and LLM until the window expires. Guided mode still starts cooldown when the review recommends archive, before the operator acts. Benign or low-confidence reviews do not start the cooldown. Link heuristics still archive or block.

## Sub-features

- `same-chat-skip` — after an LLM archive, a second message in the window → `skipped: cooldown`.
- `archive-failure-retry` — after an automatic archive fails, a follow-up can still be reviewed.
- `cooldown-write-failure` — an unwritable cooldown file does not block an automatic archive; the current process still tracks cooldown.
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
- Most tests use an in-memory store; persistence tests and `whatsapp-bot.js` use a file-backed store.
