# AGENTS.md invariants

The bot must never auto-block a saved contact. An unsaved contact auto-blocks **only** on a current-message URL in `data/malicious-hosts.json`. Lookalike and soliciting short-link heuristics archive but do not block. Models do not auto-block. **Live** inbound is link heuristics then mask→LLM — no jevlike `/v1/score` archive. Offline **lab/block-policy** tests still assert that a jevlike score alone (including at `BLOCK_THRESHOLD`) only archives and never auto-blocks, and that `ok:false` scorer output does not archive by itself.

## Sub-features

- `saved-alert-only` requires manual review instead of auto-archive or auto-block for saved contacts.
- `score-no-block` archives unsaved block-line jevlike scores and never calls block without a malicious-host match.
- `lookalike-no-block` lookalike and short_link heuristics do not pass `blockEligibility`.
- `malicious-host-block` blocks unsaved contacts when `heuristic.id === 'malicious_host'`.
- `context-archive-only` context model `block` archives only; no `blockContact`.
- `fail-closed-unknown` ignores `unknown` / `ok:false` scores in `decideIncomingAction` and in `processIncomingMessage`; no archive and no block.

## How to get to it (user POV)

- Live session: a suspicious message from a saved contact only opens a review card. An unsaved stranger with a **listed** URL is blocked and renamed in automatic mode. A lookalike without a list entry archives an unsaved chat only if masked AI confirms the scam. AI verdicts do not auto-block.
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

Exit code `0`. TAP shows passing tests under the three `AGENTS.md invariants` suites.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-agents-md-invariants/node-test.txt`. The file contains `ok` for `invariant: unsaved jevlike score at or above BLOCK_THRESHOLD alone does not block` and for `invariant: unsaved malicious_host on the current message may block`.

## Gotchas

- These tests read thresholds from `loadRubric()`. Do not edit numeric constants in production code to make proof pass.
- `BLOCK_ENABLED=false` keeps archive-only even when a malicious-host match would otherwise block; that toggle is not the default invariant path.
- Context-model tests stub the chat API with `fetchImpl`; they expect archive-only on `block` answers.
- Phrase tropes (驗證碼, 轉數快, and similar) are out of scope here; they are not hard-archive gates — judgment is link heuristics and mask→LLM.
