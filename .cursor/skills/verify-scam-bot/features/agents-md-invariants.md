# AGENTS.md invariants

Saved contacts are never auto-blocked. Unsaved auto-block **only** on a current-message URL in `data/malicious-hosts.json`. Lookalike and soliciting short-link heuristics archive but do not block. Primary LLM and context LLM do not auto-block. **No live jevlike score** drives archive; mask/LLM failure does not archive.

## Sub-features

- `saved-no-auto-block` — saved contacts skip `blockEligibility` even with malicious-host or link heuristic on the current message (archive may still apply).
- `lookalike-no-block` — lookalike and short_link heuristics do not pass `blockEligibility`.
- `malicious-host-block` — unsaved + `heuristic.id === 'malicious_host'` may block.
- `llm-archive-no-block` — LLM `llm_review_scam` archives unsaved contacts without `blockContact` unless malicious-host policy applies.
- `mask-fail-closed` — mask failure → ignore in `processIncomingMessage`.
- `context-archive-only` — context model `block` → archive only.

## How to get to it (user POV)

- Live: listed malicious URL on a stranger → block; lookalike → archive only; ordinary scam wording → mask → LLM → archive or ignore.
- Smoke: `lib/agents-invariants.test.js` with in-process stub + mocked LLM. No WhatsApp, no HTTP stub required.

## Driving it with verify-scam-bot

Preconditions: repo root; unset threshold env vars (drive script does this).

- **Scripted proof.** `.cursor/skills/verify-scam-bot/bin/drive-agents-invariants` → exit `0`, `summary.json` `"proved": true`.

- **Manual:**

```bash
node --test --test-reporter tap lib/agents-invariants.test.js
```

## Gotchas

- Tests use `lib/test-llm.js` helpers for primary-path LLM mocks.
- `BLOCK_ENABLED=false` disables malicious-host block; not the default invariant path.
- Phrase tropes without links are covered under [LLM primary](./llm-primary.md).
