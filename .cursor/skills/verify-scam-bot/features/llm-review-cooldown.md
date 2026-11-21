# Per-chat LLM cooldown

In automatic mode, a successful primary or context LLM review starts the per-chat **`LLM_REVIEW_COOLDOWN_MS`** window (default ten minutes) only after the chat is archived. That chat skips mask and LLM until the window expires. Guided mode still starts cooldown when the review recommends archive, before the operator acts. Benign or low-confidence reviews do not start the cooldown. Link heuristics still archive or block.

## Sub-features

- `same-chat-skip` — after an LLM archive, a second message in the window → `skipped: cooldown`.
- `archive-failure-retry` — after an automatic archive fails, a follow-up can still be reviewed.
- `cooldown-write-failure` — an unwritable cooldown file does not block an automatic archive or a guided review and archive vote; cooldown still works in memory.
- `prune-write-failure` — startup loads active cooldowns and drops expired ones in memory even when it cannot write the pruned file.
- `persist-restart` — a saved cooldown is reloaded from disk on `npm start` and remains active until expiry.
- `heuristic-inside-window` — lookalike hard archive without LLM.

## How to get to it (user POV)

- Several DMs from one stranger within ten minutes after an LLM archive: only the first triggers mask + LLM unless a link rule fires. A benign opener does not suppress review of the next message.
- Restart the bot mid-window: the same chat stays suppressed until expiry only if the cooldown was saved to `llm-review-cooldown.json` (`LLM_REVIEW_COOLDOWN_PATH` optional).
- Tune with `LLM_REVIEW_COOLDOWN_MS` in `.env`.

## Driving it with verify-scam-bot

Preconditions: repo root; stub not required.

```bash
.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown
```

Or manually:

```bash
LLM_REVIEW_COOLDOWN_MS=0 node --test --test-reporter tap \
  lib/llm-review-cooldown.test.js lib/wa-handlers.test.js
```

Save TAP under `evidence/<UTC-stamp>-llm-review-cooldown/`.

## Gotchas

- Failed masking or a failed LLM review never starts cooldown. In automatic mode, a failed archive does not start it either. Guided mode starts it on the archive recommendation, even if the operator later declines to archive.
- `npm test` sets `LLM_REVIEW_COOLDOWN_MS=0`; cooldown tests opt in via in-test `deps.env`.
- Most tests use an in-memory store; persistence tests and `whatsapp-bot.js` use a file-backed store.
