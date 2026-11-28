# Mask before LLM

Before any chat-API call, the bot asks jevlike `POST /v1/mask` which characters to hide and writes typed placeholders over those spans. The raw text and the span list are not sent. A truncated mask, a missing row, or a non-integer span skips the LLM call. An empty span list is a successful mask of a message that has no personal data.

## Sub-features

- `mask-http` returns one span row per input message from the stub.
- `mask-xxx` replaces a Hong Kong phone and a 我係 name with typed tokens (`<PHONE_1>`, `<NAME_1>`) and leaves the lure word 驗證碼 visible.
- `mask-incomplete` skips the chat API when the mask throws, is short a row, or has a non-integer span. The DM is not archived or blocked because the mask failed.
- `mask-empty` accepts a span list of `[]`.
- `mask-long-message` scores a message longer than the PII head's trained context (`context_tokens`) in overlapping windows, so spans at both the head and the tail are masked and the message reaches review; a tokenizer that still leaves model-visible text uncovered fails the mask (`python -m unittest test_jevlike_serve.LongMessageMaskTests`, needs torch, so CI without torch skips it).
- `mask-base-url` accepts a worker base or full `/v1/mask` endpoint with trailing slashes, without duplicating the path; lab score still resolves independently (`node --test lib/jevlike-base-url.test.js` exercises the real inbound handler over local HTTP).
- `keyword-rules` exercises lookalikes and short-link lures in both the default context and single-message paths. A benign, invalid, or unavailable review leaves the message alone; a confident scam verdict archives without auto-blocking.
- `review-disabled` skips both review paths with `LLM_REVIEW_ENABLED=false`, even with context on by default, and fails closed on every message including curated malicious hosts (`node --test lib/llm-review-disabled.test.js` uses a real local HTTP chat endpoint).
- `LLM_REVIEW_ALL=1` is a legacy compatibility flag with no effect on review enablement or trigger selection; it does not re-enable review when `LLM_REVIEW_ENABLED=false` (`lib/llm-review.test.js` covers context default-on and off).
- `benign-notices-prompt` runs `treats money received, own-account alerts and do-not-share codes as no_action` in `lib/context-llm.test.js`: the context prompt's `no_action for ordinary chat` clause names money already sent to the user, own-account bank alerts and do-not-share one-time codes; `drive-mask-before-llm` checks this test's TAP result.
- `own-turns-masked` runs `sends the user's question and the reply as masked turns marked by speaker` in `lib/context-llm.test.js`: the user's own 1:1 messages enter the context transcript marked `user:`, masked in the same `/v1/mask` call as inbound, with no raw phone in the chat-API body; `drive-mask-before-llm` checks this test's TAP result.
- `official-domain-facts` runs the `officialHosts` suite in `lib/link-rules.test.js` and `official domains in the context review prompt` in `lib/context-llm.test.js`: an allowlisted domain such as `payme.hsbc` stays readable while the rest of its link stays masked, and the context, primary and guided prompts say it is official; lookalike and unknown domains stay masked and add nothing.
- `mask-local-identity` attaches the chat-list name and phone on this machine. Those fields are not part of the mask request or the chat-API body.

## How to get to it (user POV)

- Context review is on by default (`CONTEXT_LLM_ENABLED`; set `0` or `false` for single-message primary LLM only). Optional `LLM_REVIEW_API_URL` drives the Cantonese note on a receipt or a guided card. The bot masks first, then calls that API.
- Live worker: `POST http://127.0.0.1:8766/v1/mask` with `{"messages":["..."]}` (at most 10 strings). Without `models/jevlike_hf_pii_mask.pt` the worker returns 503 `{"error":"pii mask head is not loaded"}` and the bot sends nothing.
- Smoke path: the same POST against the stub from `bin/launch-stub`. The stub fills spans with the offline helper `find_mask_spans` so the tests do not load the encoder. That 200 is the stub contract, not proof that the PII head is loaded.

## Driving it with verify-scam-bot

Preconditions:

- For the HTTP check, `bin/doctor` prints `worth_driving: yes`.
- For the decision checks, working directory is the repo root and `CONTEXT_LLM_ENABLED` in the shell is unset. The tests pass `enabled: true` themselves.
- No chat-API key is required. The tests inject `fetchImpl`.

- **Stub mask.** With the stub base URL in `$BASE` (from `.cursor/skills/verify-scam-bot/run/base-url`):

```bash
curl -fsS -X POST "$BASE/v1/mask" \
  -H 'content-type: application/json' \
  -d '{"messages":["我係陳大文 電話 91234567 驗證碼過期請發俾我"]}'
```

Exit code `0`. JSON has `"ok": true`, `"model": "stub-jevlike"`, `"method": "identifier_spans"`, and `messages[0].spans` is a non-empty array of `{start, end, label}`. Save the body under `evidence/<UTC-stamp>-mask-before-llm/mask.json`.

- **Empty spans stay success.** `POST /v1/mask` body `{"messages":["今晚飲茶？"]}`. Exit code `0`. `messages[0].spans` is `[]`.

- **Masked transcript reaches the model.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'sends the masked recent messages and archives when the model says archive|replaces phone, name, and otp with typed placeholders and keeps the lure word' \
  lib/context-llm.test.js
```

Exit code `0`. The user message contains typed mask tokens and `驗證碼`, and does not contain `6123` or `陳大文`.

- **Failed mask skips the model and does not archive.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'does not call the model when masking fails|rejects a mask payload that would leave the text raw' \
  lib/context-llm.test.js lib/audit-functions.test.js
```

Exit code `0`. The context-LLM case ends `action` `ignore` and `skipped` `mask_failed`. The audit case rejects an empty span object with `incomplete mask` and does not call the chat API.

- **Proof.** Save `mask.json` and both TAP transcripts under `evidence/<UTC-stamp>-mask-before-llm/`. The HTTP file shows the spans. The TAP file shows the chat body after `XXX` replacement.

## Gotchas

- Primary review requires a `scam` label and sufficient confidence. Contradictory `should_archive: true` on `not_scam`, `unknown`, invalid or missing labels does not archive. `lib/llm-review.test.js` locks parsing, merge and the real handler; `drive-mask-before-llm` runs these cases.
- A mask that is truncated, short a row, or has a non-integer span is a failed mask. The LLM call is skipped. That failure does not archive or block.
- A message longer than the trained context is not a truncated mask: the live worker scores it in overlapping windows. Trailing characters the tokenizer emits no token for (spaces, an emoji variation selector) do not count as truncated.
- Empty `spans` arrays are success.
- The stub's 200 uses the offline span helper. Live `/v1/mask` returns only the PII head. A missing head is 503, and the bot skips the LLM call the same way.
- Lure words such as 驗證碼 are cleared from the mask so the later model still sees them.
- The receipt and the guided card attach the chat-list name and phone locally after the mask. They are not added to the prompt.
- Curated malicious-host hits also go through mask → LLM with a device-checked system prompt note (never leaking the raw hostname) so the model distinguishes lures from anti-scam warnings. Guided mode may still ask for a Cantonese explanation after the same mask, and that reply cannot archive, block, or hide the card.
