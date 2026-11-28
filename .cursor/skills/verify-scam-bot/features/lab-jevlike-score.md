# Lab jevlike score (not live inbound)

**Lab / eval only.** `POST /v1/score` and `lab/score-message.js` map stub probabilities to the 0–100 rubric interface. Live DMs do **not** archive from score alone — they use [mask before LLM](./mask-before-llm.md).

## Sub-features

- `stub-score-http` — scam/benign preset bodies return expected labels on the stub worker.
- `createMaskClient` — always `JevlikeClient`; `SCORER` env ignored.
- `score-fail-closed` — timeout/5xx → `ok:false` (`label: 'unknown'`; no score-only archive on inbound).

## How to get to it (user POV)

- Operators do not use this on WhatsApp. Developers run the drive below to exercise the stub `POST /v1/score` route and the tests for `scoreMessage` in `lab/score-message.js`.

## Driving it with verify-scam-bot

Preconditions: `bin/launch-stub`, `bin/doctor` → `worth_driving: yes`.

```bash
.cursor/skills/verify-scam-bot/bin/drive-score-archive
```

Writes `evidence/<stamp>-lab-jevlike-score/` with score HTTP samples and TAP from `lib/scorer.test.js` + selected `whatsapp-bot.test.js` lab cases.

## Gotchas

- A high stub score in tests does **not** prove live archive — use `drive-mask-before-llm` or `drive-agents-invariants` for product behavior.
- `drive-score-archive` is the script name for backward compatibility; evidence feature id is `lab-jevlike-score`.
