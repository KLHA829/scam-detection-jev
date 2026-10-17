# Benign DM ignore

Ordinary 1:1 chat with no link heuristic and LLM answer **not scam** stays **ignore** — no archive, no block.

## Sub-features

- `decide-ignore` — `decideIncomingAction` ignore before LLM when no heuristic.
- `llm-not-scam` — stub LLM returns not_scam → ignore after mask.

## How to get to it (user POV)

- Friend sends casual Cantonese with no suspicious link → message remains in inbox.
- Saved or unsaved: no auto-block without malicious-host URL.

## Driving it with verify-scam-detection-jev

Preconditions:

- In-process stub mask client (tests); no WhatsApp.

- **Decide path.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'invariant: non-heuristic messages ignore before LLM merge' \
  lib/agents-invariants.test.js
```

Exit code `0`.

- **Proof.** TAP saved to `artifacts/<UTC-stamp>-benign-ignore/node-test.txt`.

## Gotchas

- Heuristic hit on **current** message skips LLM entirely (fast archive).
- This feature does not prove LLM scam archive; see mask-llm-primary and agents-invariants.
