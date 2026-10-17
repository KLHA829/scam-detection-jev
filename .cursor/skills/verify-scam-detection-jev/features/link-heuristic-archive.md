# Link heuristic archive only

Lookalike brand URLs and **soliciting** short links (OTP/money/impersonation + shortener) **archive** as `obvious_scam`. They do **not** auto-block unsaved contacts unless the URL is also on the malicious-host list.

## Sub-features

- `lookalike` — e.g. `whatsapp-secure.com` → archive, no block.
- `short-solicit` — `請提供驗證碼 https://bit.ly/...` → archive.
- `allowlist` — `sf-express.com`, `github.io`, etc. do not hit.

## How to get to it (user POV)

- Unsaved sender includes a suspicious link without a listed malicious host → chat archived, contact not blocked.
- Live session shows archive receipt; contact name unchanged unless operator chose guided block.

## Driving it with verify-scam-detection-jev

Preconditions:

- `HEURISTIC_ENABLED` unset (true).
- `BLOCK_ENABLED` unset (true) — block policy must still not promote lookalike to block.

- **Lookalike integration test.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'archives an unsaved lookalike without auto-block|invariant: unsaved lookalike archives' \
  lib/link-rules.test.js lib/agents-invariants.test.js
```

Exit code `0`. TAP shows `action: archive`, no `blockContact` call.

- **Proof.** Save TAP under `artifacts/<UTC-stamp>-link-heuristic-archive/node-test.txt`.

## Gotchas

- Bare `bit.ly` without solicit wording does not archive.
- `youtu.be` is not treated as a soliciting short link.
- Dual-hit URLs on the malicious list block — see [malicious-host-block](./malicious-host-block.md).
