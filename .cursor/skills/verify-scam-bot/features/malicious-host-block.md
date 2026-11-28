# Malicious-host auto-block

Unsaved contacts are **auto-blocked only** when the current message URL matches a host in `data/malicious-hosts.json` (exact or suffix) **and** masked LLM review confirms scam. The contact name becomes `封鎖·惡意域名`, the chat is archived, and `blocks.jsonl` gains a line. Saved contacts never auto-block. Lookalike heuristics, short links, jevlike lab scores, and LLM answers alone do not auto-block.

## Sub-features

- `list-match` matches exact host and subdomains (e.g. `pay.evil.example` matches `evil.example`).
- `idn-match` matches Unicode and punycode URL spellings against either list spelling, without widening path entries or changing IPv6 rules. Bare Unicode host extraction remains outside this proof.
- `hot-reload` refreshes the cached list after in-place writes, repeated atomic saves, and atomic saves to a symlink target in another directory.
- `reject-malformed` a reload with a non-string `hosts` entry (e.g. an object) fails and keeps the previous list; at startup it exits like invalid JSON.
- `unsaved-block` calls `blockContact` with `封鎖·惡意域名` when the heuristic id is `malicious_host`.
- `score-free-records` new block records, guided queue entries, and action log lines omit the live placeholder score; old scored queue entries remain actionable. Separate proof: `node --test lib/placeholder-score.test.js` (not included in `bin/drive-malicious-host-block`).
- `email-archive-only` archives a blocklisted email domain without calling `blockContact`; a separate blocklisted URL in the same message can still block.
- `forwarded-warning-review` drives the WhatsApp message handler: both anti-scam warnings and lures quoting a blocklisted URL route through masked AI review (with a device-checked system prompt note, no raw host leak); benign warnings stay ignored while AI-confirmed lures from unsaved senders block.
- `no-jevlike-score` blocks after masked LLM confirmation without any legacy scorer path.
- `saved-alert-only` suspicious DMs from saved contacts open a review card even in automatic mode or before setup. No archive or block runs until the operator chooses. If a queued action finds the contact was just saved, the bot defers it as well.
- `hold-setup` while the first-run setup poll is unanswered, `holdBlock` suppresses automatic blocks and still lets unsaved chats archive.

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
  --test-name-pattern 'blocks a malicious host after masked LLM confirmation|holds auto-block while the setup choice is unanswered' \
  lib/block-policy.test.js
```

Exit code `0`. TAP shows block with `blockReason` `malicious_host` and contact name `封鎖·惡意域名`.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-malicious-host-block/node-test.txt`. Include `ok` for `blocks an unsaved contact on a listed host after masked LLM confirmation`.

## Gotchas

- Lookalike URLs such as `whatsapp-secure.com` are **not** on the default list; they require AI review (see [link-lookalike-archive](./link-lookalike-archive.md)).
- `BLOCK_ENABLED=false` keeps archive-only even for listed hosts.
- Do not use the list for heuristic recall; it is operator-confirmed malicious domains only.
- Extending the list: add strings to the `hosts` array in JSON; no code change required.
