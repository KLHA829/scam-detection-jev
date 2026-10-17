# Malicious-host auto-block

When an **unsaved** contact sends a message whose URL matches **`data/malicious-hosts.json`**, the bot archives and **blocks** (contact name `封鎖·惡意域名`). Saved contacts never auto-block. Scores, lookalike-only URLs, short-link solicit, and LLM answers do not auto-block.

## Sub-features

- `list-match` — exact host and subdomain suffix match.
- `unsaved-block` — `processIncomingMessage` → `action: block`, `blockReason: malicious_host`.
- `before-llm` — link heuristic fast path; no wait on LLM or lab score.
- `dual-hit` — host on list wins over lookalike id for block eligibility.

## How to get to it (user POV)

- Operator maintains `data/malicious-hosts.json` (or `MALICIOUS_HOSTS_PATH`).
- Live: stranger DM with `https://pay.<listed-host>/...` → block + receipt to self-chat.
- Offline smoke: shipped host `malicious-block-test.invalid`.

## Driving it with verify-scam-detection-jev

Preconditions:

- Repo root; `BLOCK_ENABLED` and `HEURISTIC_ENABLED` unset (defaults on).
- For full prove loop: `bin/launch-stub` then `bin/doctor` → `worth_driving: yes`.

- **Scripted proof.** Run:

```bash
.cursor/skills/verify-scam-detection-jev/bin/prove-malicious-host-block
```

Exit code `0`. Latest `artifacts/<stamp>-malicious-host-block/summary.json` has `"proved": true`.

- **Drive only (no launch).** Run:

```bash
.cursor/skills/verify-scam-detection-jev/bin/drive-malicious-host-block
```

- **Proof.** `node-test.txt` includes `ok` for `blocks an unsaved contact on a listed host without waiting for the scorer` and `prefers malicious_host over lookalike when both match`.

## Gotchas

- Lookalike hosts **not** on the list archive only ([link-heuristic-archive](./link-heuristic-archive.md)).
- Empty `hosts:[]` reload keeps the previous list unless `MALICIOUS_HOSTS_ALLOW_EMPTY=1`.
- Default JSON lists test-infra hosts only; production auto-block needs operator-confirmed domains.
