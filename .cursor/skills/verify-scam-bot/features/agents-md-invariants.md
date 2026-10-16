# AGENTS.md invariants

The bot must never auto-block a saved contact. An unsaved contact blocks only on a current-message link rule or an explicit context-model `block`, not on jevlike score alone (including score at the block line from `scoring-rubric.json`). A failed or unknown scorer does not archive by itself.

## Sub-features

- `saved-no-auto-block` keeps saved contacts at archive when a link rule or block-line score would block an unsaved chat.
- `score-no-block` archives unsaved block-line jevlike scores and never calls block without link rule or context `block`.
- `link-rule-block` blocks unsaved contacts on a current-message lookalike host before the scorer returns.
- `context-block` blocks unsaved contacts when the context model returns explicit `block`.
- `fail-closed-unknown` ignores `unknown` / `ok:false` scores in `decideIncomingAction` and in `processIncomingMessage`; no archive and no block.

## How to get to it (user POV)

- Live session: a saved contact who sends a high-risk or lookalike URL is archived only. An unsaved stranger with the same URL is blocked and renamed. A high score without a link rule archives but does not block.
- Smoke path: `node --test lib/agents-invariants.test.js` exercises `blockEligibility`, `applyBlockPolicy`, `decideIncomingAction`, and `processIncomingMessage` with the in-process stub client. No WhatsApp session and no HTTP stub worker are required.

## Driving it with verify-scam-bot

Preconditions:

- Repo root is the working directory.
- `npm ci` has been run if you will run the full suite afterward (`lib/wa-handlers.test.js` needs `whatsapp-web.js`).
- Unset `ARCHIVE_THRESHOLD`, `SAFE_THRESHOLD`, `BLOCK_THRESHOLD`, `BLOCK_ENABLED`, `HEURISTIC_ENABLED`, `OPERATOR_MODE`, `CONTEXT_LLM_ENABLED`, `LLM_REVIEW_ENABLED`, and `SCORER`. Committed lines are archive 42, safe 18, block 80 in `scoring-rubric.json`.
- The HTTP stub is not required for this feature.

- **Scripted proof.** Run `.cursor/skills/verify-scam-bot/bin/drive-agents-invariants`. Exit code `0`. `summary.json` has `"proved": true`. `node-test.txt` contains `# fail 0` and an `ok` line for every invariant test named in that script.

- **Manual subset.** From the repo root, with threshold env vars unset:

```bash
node --test --test-reporter tap lib/agents-invariants.test.js
```

Exit code `0`. TAP shows 14 passing tests under the three `AGENTS.md invariants` suites.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-agents-md-invariants/node-test.txt`. The file contains `ok` for `invariant: unsaved jevlike score at or above BLOCK_THRESHOLD alone does not block` and for `invariant: scorer failure alone never archives in the live decision path`.

## Gotchas

- These tests read thresholds from `loadRubric()` / `resolveBlockThreshold()`. Do not edit numeric constants in production code to make proof pass.
- `BLOCK_ENABLED=false` keeps archive-only even when a link rule would otherwise block; that toggle is not the default invariant path.
- Context-model block tests stub the chat API with `fetchImpl`; they do not call a live LLM.
- Phrase tropes (驗證碼, 轉數快, and similar) are out of scope here; they follow score and link rules in other features.
