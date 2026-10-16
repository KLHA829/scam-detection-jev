# Malicious-host auto-block

Unsaved contacts are **auto-blocked only** when the current message URL matches a host in `data/malicious-hosts.json` (exact or suffix). The contact name becomes `封鎖·惡意域名`, the chat is archived, and `blocks.jsonl` gains a line. Saved contacts never auto-block. Scores, lookalike heuristics, soliciting short links, and LLM answers do not auto-block.

## Sub-features

- `list-match` matches exact host and subdomains (e.g. `pay.evil.example` matches `evil.example`).
- `unsaved-block` calls `blockContact` with `封鎖·惡意域名` when the heuristic id is `malicious_host`.
- `before-score` blocks without waiting for the scorer (same fast-heuristic path as link rules).
- `saved-archive-only` saved contacts on a malicious URL archive if the link rule fires; `applyBlockPolicy` does not block.
- `hold-setup` while the first-run setup poll is unanswered, `holdBlock` suppresses block but still archives lookalike; malicious-host block is also held until the operator picks automatic mode.

## How to get to it (user POV)

- Maintain `data/malicious-hosts.json` with confirmed-bad registrable hosts. Optional override: `MALICIOUS_HOSTS_PATH`.
- Live session: an unsaved stranger sends a message containing a listed URL → block, mute, archive, receipt to your own chat.
- Smoke path: shipped test host `malicious-block-test.invalid` in the JSON file; offline tests use `https://malicious-block-test.invalid/...`.

## Driving it with verify-scam-bot

Preconditions:

- Repo root is the working directory.
- `BLOCK_ENABLED` unset (enabled). `HEURISTIC_ENABLED` unset (enabled).
- No HTTP stub worker required for `lib/malicious-hosts.test.js` and related `processIncomingMessage` cases.

- **Scripted proof.** Run:

```bash
.cursor/skills/verify-scam-bot/bin/drive-malicious-host-block
```

Exit code `0`. `summary.json` has `"proved": true`.

- **Manual subset.**

```bash
node --test --test-reporter tap lib/malicious-hosts.test.js
node --test --test-reporter tap \
  --test-name-pattern 'blocks a malicious host without waiting for the scorer|holds auto-block while the setup choice is unanswered' \
  lib/block-policy.test.js
```

Exit code `0`. TAP shows block with `blockReason` `malicious_host` and contact name `封鎖·惡意域名`.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-malicious-host-block/node-test.txt`. Include `ok` for `blocks an unsaved contact on a listed host without waiting for the scorer`.

## Gotchas

- Lookalike URLs such as `whatsapp-secure.com` are **not** on the default list; they archive only (see [link-lookalike-archive](./link-lookalike-archive.md)).
- `BLOCK_ENABLED=false` keeps archive-only even for listed hosts.
- Do not use the list for heuristic recall; it is operator-confirmed malicious domains only.
- Extending the list: add strings to the `hosts` array in JSON; no code change required.
