# AGENTS.md invariants

Offline locks for elderly precision-first policy: saved never auto-block, score alone never block, lookalike/short-link never block, malicious-host may block unsaved, mask fail-closed.

## Sub-features

- `block-eligibility` — unit tests on `blockEligibility` / `applyBlockPolicy`.
- `integration` — `processIncomingMessage` with stub `maskClient`.
- `copy-traps` — `lib/agent-trust.test.js` README and import bans.

## How to get to it (user POV)

- Policy changes must keep these tests green before merge.
- Operator relies on the same rules live; tests use callbacks instead of WhatsApp writes.

## Driving it with verify-scam-detection-jev

Preconditions:

- `npm ci` if running full `npm test`.

- **Invariant suite.** Run:

```bash
node --test --test-reporter tap lib/agents-invariants.test.js lib/agent-trust.test.js
```

Exit code `0`.

- **Full repo offline gate.** Run:

```bash
npm test
```

- **Proof.** TAP under `artifacts/<UTC-stamp>-agents-invariants/`.

## Gotchas

- Do not re-enable `scoreClient` on inbound; agent-trust test fails on regression.
- Lab score remains in `lab/score-message.js` only.
