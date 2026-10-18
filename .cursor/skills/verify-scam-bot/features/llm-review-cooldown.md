# LLM review cooldown persistence

After a successful primary or context LLM review (`ok === true`), the same `chatId` skips mask+LLM until `LLM_REVIEW_COOLDOWN_MS` expires. That window survives a bot process restart when the persisted store is used (`llm-review-cooldown.json` by default, or `LLM_REVIEW_COOLDOWN_PATH`). Link-heuristic archives still bypass cooldown.

## Sub-features

- Per-chat cooldown after successful LLM review
- On-disk JSON store with prune-on-load and atomic writes
- Heuristic hard-hit still archives inside the cooldown window

## How to get to it (user POV)

1. An unsaved or saved contact sends a normal DM; the bot masks and runs the LLM.
2. A second normal DM from the same chat within ten minutes is ignored without another LLM call.
3. Restart `npm start`; the second DM within the window is still suppressed until expiry.
4. A lookalike or short-link URL in the current message still archives immediately.

## Driving it with verify-scam-bot

```bash
.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown
```

Offline only: runs `lib/llm-review-cooldown.test.js` with `LLM_REVIEW_COOLDOWN_MS=600000`. Doctor and stub launch are not required.

## Gotchas

- `npm test` sets `LLM_REVIEW_COOLDOWN_MS=0` globally so unrelated suites do not hit cooldown; use the drive script or run the cooldown test file with a positive cooldown.
- Tests inject an in-memory store; production uses the file-backed store from `whatsapp-bot.js`.
