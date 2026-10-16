# LLM primary archive (replaces score-archive)

**Deprecated (2026-10-16):** jevlike `POST /v1/score` no longer drives live archive. Non-heuristic DMs: **mask → LLM** → `llm_review_scam` or ignore. Stub `/v1/score` remains for lab eval only.

## Sub-features

- `llm-scam` — mocked Chat Completions returns `scam` → archive `llm_review_scam`.
- `llm-not-scam` — mocked LLM returns `not_scam` → ignore.
- `mask-fail-closed` — mask throws → LLM not called → ignore.
- `heuristic-skip-llm` — lookalike archive `obvious_scam` without LLM.
- `malicious-host-block` — see [malicious-host-block](./malicious-host-block.md) (separate from LLM).

## Driving it with verify-scam-bot

Use `npm test` patterns in `lib/agents-invariants.test.js`, `lib/llm-review.test.js`, and `lib/test-llm.js` helpers (`primaryPathDeps`, `scamLlmFetch`).

Historical score-archive TAP names in old evidence folders refer to the pre-2026-10-16 product.
