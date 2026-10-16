# LLM primary (mask → archive/ignore)

Non-heuristic 1:1 DMs are masked locally, then judged by the OpenAI-compatible LLM (`LLM_REVIEW_ENABLED` default **on**). Archive reason `llm_review_scam`; mask or LLM failure leaves the chat alone. Link heuristics still hard-archive without the LLM.

## Sub-features

- `llm-scam` — mocked Chat Completions returns `scam` → archive `llm_review_scam`, no auto-block.
- `llm-not-scam` — mocked LLM returns `not_scam` → ignore.
- `mask-fail-closed` — mask throws → LLM not called → ignore.
- `llm-fail-closed` — LLM timeout/unknown → ignore (no jevlike score fallback).
- `heuristic-skip-llm` — lookalike archive `obvious_scam` without LLM.
- `stub-mask-http` — stub `POST /v1/mask` returns identifier spans (offline helper).

## How to get to it (user POV)

- Live session, after worker + `LLM_REVIEW_API_URL` are set: a normal chat DM is masked, sent to the LLM, then archived or ignored. Groups and link-heuristic hits follow their own paths (see other features).
- Smoke path: stub on `127.0.0.1:18766`, then `bin/drive-llm-primary`. No WhatsApp QR.

## Driving it with verify-scam-bot

Preconditions:

- `bin/launch-stub` then `bin/doctor` → `worth_driving: yes`.
- `npm ci` before full `npm test` if you need `whatsapp-web.js` tests.

- **Scripted proof.** Run `.cursor/skills/verify-scam-bot/bin/drive-llm-primary`. Exit code `0`. `summary.json` has `"proved": true`. `mask.json` shows non-empty spans for the PII sample; `mask-empty.json` shows `[]`. `node-test.txt` has `# fail 0` and an `ok` line for every test named in the script.

- **Manual subset** (repo root, threshold env vars unset):

```bash
node --test --test-reporter tap \
  --test-name-pattern 'archives grey messages when LLM says scam|fail-closed: LLM unknown|processIncomingMessage calls the LLM on every non-heuristic DM by default|LLM primary path archives when the LLM says scam' \
  lib/llm-review.test.js lib/agents-invariants.test.js whatsapp-bot.test.js
```

Exit code `0`.

## Gotchas

- Live inbound does **not** call `POST /v1/score`. Stub `/v1/score` remains for lab eval only.
- `drive-score-archive` is a deprecated alias that runs `drive-llm-primary`.
- Phrase tropes without unsafe links need the LLM (or context LLM fork), not a local score.
