# Link lookalike AI review (no auto-block)

An unsaved contact who sends a lookalike host goes to masked AI review and is archived only if the AI confirms a scam. Auto-block does **not** run on lookalike heuristics (elderly precision-first). Short links have no separate heuristic rule and go straight to masked AI review. An allowlisted host such as `sf-express.com` does not hit. A host on `github.io`, `medium.com`, or `blogspot.com` does not hit. A bare `whatsapp-secure.com/login` does. For a saved contact, an AI-confirmed scam opens an operator review card instead of taking automatic action.

## Sub-features

- `lookalike-archive` archives an unsaved chat whose current message contains a lookalike host and AI confirms the scam.
- `lookalike-shapes` hits `whatsapp-secure.com`, a one-character misspelling, a homoglyph, and a `userinfo@evil` URL.
- `allowlist` leaves `sf-express.com`, `hsbc.com.hk`, `wa.me`, `chat.whatsapp.com`, and `whatsapp.com` unflagged.
- `hsbc-regional` sends official UK, China, Australia, and Singapore HSBC domains and their subdomains to mask → LLM without a lookalike rule hit. Lookalikes on unrelated hosts still hit. Covered by `bin/drive-mask-before-llm`.
- `short-links-to-ai` routes short links (with or without OTP, money, impersonation, or advice text) directly to masked AI review without a link-rule hit (`routes short links (including OTP, money, and impersonation text) directly to masked AI review` and `sends short-link advice and authority mentions to masked AI review` in `lib/link-rules.test.js`, included in `bin/drive-mask-before-llm`).
- `curated-host-review` in `lib/link-rules.test.js` covers routing both warnings and lures containing a curated malicious host through mask → LLM with a device-checked system note (never leaking raw hostnames), across both contact states and both review paths, plus mask failure fail-closed. Included in `bin/drive-mask-before-llm`.
- `saved-alert-only` sends a saved contact's lookalike hit or short-link lure to masked AI review and opens an operator review card only if AI confirms the scam.
- Advice remains fail-closed on mask errors (`fails closed when masking short-link advice fails`, also in `bin/drive-mask-before-llm`).

## How to get to it (user POV)

- Live session: an unsaved number sends a 1:1 message that contains the URL. If AI confirms a scam, the chat is archived; the contact is not renamed with `封鎖·` unless the URL is also on the malicious-host list (see [malicious-host-block](./malicious-host-block.md)).
- A saved address-book contact who sends the same URL also goes to AI review and gets a review card if AI confirms the scam. The operator decides whether to archive, block and archive, or leave the chat.
- Smoke path: `node --test` on `lib/link-rules.test.js` and block-policy cases with `savedContact: false` and the in-process benign stub. The link rule fires even when that stub score is 4.

## Driving it with verify-scam-bot

Preconditions:

- Repo root is the working directory.
- `HEURISTIC_ENABLED` is unset (enabled). `BLOCK_ENABLED` is unset (enabled).
- The HTTP stub is not required. These tests construct `createStubJevlikeClient('benign')` in process.
- Do not set `OPERATOR_MODE=guided` in the environment. Guided mode defers archive until the poll; that is the guided-poll feature.

- **Allowlist and bare short link.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'does not flag allowlisted hosts, a bare short link, or a short link with bill-splitting' \
  lib/link-rules.test.js
```

Exit code `0`. The test covers `https://www.sf-express.com/hk`, `https://wa.me/85261234567`, `https://www.hsbc.com.hk/transfer`, and `https://bit.ly/menu`.

- **Lookalike shapes.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'flags lookalike hosts, one-character misspellings, homoglyphs, and userinfo tricks' \
  lib/link-rules.test.js
```

Exit code `0`. `https://whatsapp-secure.com/login` is id `lookalike_domain`.

- **Short links route to AI review.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'routes short links \(including OTP, money, and impersonation text\) directly to masked AI review' \
  lib/link-rules.test.js
```

Exit code `0`. Short links return `hit: false` and go straight to masked AI review.

- **Unsaved archive (no block).** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'archives an unsaved lookalike without auto-block when AI confirms|archives a lookalike without blocking' \
  lib/link-rules.test.js lib/block-policy.test.js
```

Exit code `0`. Decision action is `archive`; `blockContact` is not called.

- **Saved contact does not get auto-archived or auto-blocked.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'alerts on suspicious saved contacts' \
  lib/wa-handlers.test.js
```

Exit code `0`. Saved-contact recommendations are deferred and make no automatic writes.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-link-lookalike-archive/node-test.txt`. The file contains `ok` for `archives an unsaved lookalike without auto-block` and for `does not flag allowlisted hosts, a bare short link, or a short link with bill-splitting`.

## Gotchas

- The hardcoded hit is the link on the current message. 驗證碼, 轉數快, 封號, USDT, and 順豐清關 wording do not archive without AI confirmation.
- `https://www.sf-express.com/hk` is allowlisted. `https://sf-express-hk.com/pay` is a lookalike.
- `HEURISTIC_ENABLED=0` or `false` turns the link rule off.
- While the first-run setup poll is unanswered, auto-blocks are suppressed, but unsaved chats can still auto-archive.
- In guided mode an AI-confirmed `archive` is deferred, and `processIncomingMessage` does not call archive until the operator picks **只封存** or **封鎖並封存**.
- Auto-block is only for URLs on `data/malicious-hosts.json`, not for lookalike heuristics.
