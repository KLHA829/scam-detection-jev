# Mask then LLM (fail closed)

Non-heuristic DMs go **mask → primary LLM**. If `POST /v1/mask` fails or the PII head is unavailable, the bot **does not** call the LLM and **does not** archive (fail closed).

## Sub-features

- `mask-fail-ignore` — mask throws → `decision.action: ignore`, no archive callback.
- `mask-http` — stub worker returns spans for `/v1/mask` in offline harness.
- `no-regex-fallback` — production inbound must not use `test/support/mask-spans-stub.js`.

## How to get to it (user POV)

- Live: jevlike worker without mask head → suspicious text DMs stay in inbox (no LLM archive).
- Operator still gets receipts for heuristic archives; mask failure on LLM path skips archive.

## Driving it with verify-scam-detection-jev

Preconditions:

- Optional: `bin/launch-stub` for HTTP mask probe.
- `LLM_REVIEW_ENABLED` unset (true) for integration tests that expect LLM path when mask succeeds.

- **Fail-closed integration.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'invariant: mask failure alone never archives' \
  lib/agents-invariants.test.js
```

Exit code `0`.

- **HTTP mask on stub (after launch-stub).** Run:

```bash
BASE=$(cat .cursor/skills/verify-scam-detection-jev/run/base-url)
curl -fsS -X POST "$BASE/v1/mask" -H 'content-type: application/json' \
  -d '{"messages":["電話91234567"]}' | tee artifacts/manual-mask.json
```

Response includes `spans` array (stub uses offline span helper).

- **Proof.** TAP line for mask failure; optional mask JSON saved under `artifacts/`.

## Gotchas

- Link-rule hard archives skip LLM even when mask would fail.
- `lib/agent-trust.test.js` enforces no mask-stub import on live modules.
- Real worker needs `JEVLIKE_MASK_CKPT`; stub does not download the encoder.
