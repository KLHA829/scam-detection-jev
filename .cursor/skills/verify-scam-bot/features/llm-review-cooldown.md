# Per-chat LLM cooldown

A successful primary or context LLM review starts the per-chat **`LLM_REVIEW_COOLDOWN_MS`** window (default ten minutes) after a successful automatic archive or on a deferred recommendation, including for saved contacts. That chat skips mask and LLM for ordinary messages until the window expires. Benign or low-confidence reviews do not start cooldown. Curated blocklist matches bypass the cooldown so they are still reviewed by mask → LLM; only listed URLs confirmed as scam can auto-block unsaved contacts.

## Sub-features

- `same-chat-skip` — after an LLM archive, a second message in the window → `skipped: cooldown`.
- `archive-failure-retry` — after an automatic archive fails, a follow-up can still be reviewed.
- `cooldown-write-failure` — an unwritable cooldown file does not block an automatic archive or a guided review and archive vote; cooldown still works in memory.
- `prune-write-failure` — startup loads active cooldowns and drops expired ones in memory even when it cannot write the pruned file.
- `persist-restart` — a saved cooldown is reloaded from disk on `npm start` and remains active until expiry.
- `heuristic-inside-window` — known malicious URL bypasses cooldown for masked LLM review and archives/blocks if confirmed scam.
- `user-restored` — after the user un-archives a chat the bot archived, whether seen live or reconciled from a whatsmeow full sync, a confident model verdict past the cooldown only sends the review card; a malicious-host URL still blocks.

## How to get to it (user POV)

- Several DMs from one stranger within ten minutes after an LLM archive: only the first triggers mask + LLM. Curated blocklist matches can bypass the cooldown. A benign opener does not suppress review of the next message.
- Restart the bot mid-window: the same chat stays suppressed until expiry only if the cooldown was saved to `llm-review-cooldown.json` (`LLM_REVIEW_COOLDOWN_PATH` optional).
- Tune with `LLM_REVIEW_COOLDOWN_MS` in `.env`.

## Driving it with verify-scam-bot

From the repo root, install dependencies with `PUPPETEER_SKIP_DOWNLOAD=true npm ci` if needed. Neither the stub server nor Chrome is required.

```bash
.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown
```

Or manually:

```bash
LLM_REVIEW_COOLDOWN_MS=0 node --test --test-reporter tap \
  lib/llm-review-cooldown.test.js lib/wa-handlers.test.js lib/wa-transport/whatsmeow.test.js
cd wa-bridge && go test ./... -run TestBridgeArchiveEventReconcilesSyncRestores -count=1
```

Save TAP under `evidence/<UTC-stamp>-llm-review-cooldown/`.

## Gotchas

- Failed masking, a failed LLM review, or a failed automatic archive never starts cooldown. A deferred recommendation starts cooldown even if the operator later declines to archive.
- `npm test` sets `LLM_REVIEW_COOLDOWN_MS=0`; cooldown tests opt in via in-test `deps.env`.
- Most tests use an in-memory store; persistence tests and `whatsapp-bot.js` use a file-backed store.
- Guided voting still needs a writable review queue (`REVIEW_QUEUE_PATH`); cooldown storage is separate.
