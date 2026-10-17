# Per-chat LLM cooldown

After a **successful** primary or context LLM review for one `chatId`, the bot skips further **mask + LLM** for that chat until **`LLM_REVIEW_COOLDOWN_MS`** elapses (default **600000** = 10 minutes, in-memory; restart clears). Link heuristics still archive/block; other messages **ignore** (no stale LLM archive). Guided/operator paths are unchanged.

## Sub-features

- `same-chat-skip` — second DM in the window → `llmTrigger.skipped: cooldown`, no extra LLM or mask calls.
- `window-expiry` — after the window, LLM runs again for the same chat.
- `other-chat-free` — cooldown on chat A does not block LLM on chat B.
- `heuristic-inside-window` — lookalike / hard link rules still archive without LLM during cooldown.

## How to get to it (user POV)

- Live: a stranger sends several plain-text DMs within ten minutes after the bot already ran the big model once on that chat — only the first non-heuristic message triggers mask + LLM; follow-ups stay in the inbox unless a link rule hits.
- Override window: `LLM_REVIEW_COOLDOWN_MS=300000` (five minutes) in the shell that starts `npm start`.
- `npm test` sets `LLM_REVIEW_COOLDOWN_MS=0` so the rest of the suite stays isolated; this feature drive runs the tests that opt into cooldown explicitly.

## Driving it with verify-scam-detection-jev

Preconditions:

- Repo root; `npm ci` if `lib/wa-handlers.test.js` is part of a wider run.
- Pure `node --test` — stub launch and doctor are **not** required.

- **Scripted proof.** Run:

```bash
.cursor/skills/verify-scam-detection-jev/bin/drive-llm-review-cooldown
```

Exit code `0`. Latest `artifacts/<stamp>-llm-review-cooldown/summary.json` has `"proved": true`.

- **Manual subset.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'processIncomingMessage llm cooldown|llm-review-cooldown helpers' \
  lib/llm-review-cooldown.test.js
```

Exit code `0`. TAP includes `ok` for `skips LLM and mask for a second message in the same chat within the window` and `still archives on heuristic hard-hit inside the cooldown window`.

- **Proof.** Save `node-test.txt` and `summary.json` under `artifacts/<UTC-stamp>-llm-review-cooldown/`.

## Gotchas

- Cooldown is recorded only when the LLM returns `ok: true` (HTTP completed and JSON parsed). Mask failure, timeout, or `unknown` does **not** start the window.
- During cooldown the bot does **not** call `POST /v1/mask` for the skipped LLM path (cost saving on the worker).
- Primary-path tests in `lib/llm-review-cooldown.test.js` set `CONTEXT_LLM_ENABLED: false` so they exercise single-message review; context LLM uses the same store when enabled.
- Inject `deps.llmCooldownStore` in tests; production uses the module default `Map`.
