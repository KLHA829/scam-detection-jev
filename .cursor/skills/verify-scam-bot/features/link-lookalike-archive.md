# Link lookalike AI review (no auto-block)

An unsaved contact who sends a lookalike host, or a short link that also asks for a code, impersonates, or urgently demands money, goes to masked AI review and is archived only if the AI confirms a scam. Auto-block does **not** run on these heuristics (elderly precision-first). An allowlisted host such as `sf-express.com` does not hit. A host on `github.io`, `medium.com`, or `blogspot.com` does not hit. A bare `whatsapp-secure.com/login` does. `youtu.be` is not a short link. For a saved contact, an AI-confirmed scam opens an operator review card instead of taking automatic action.

## Sub-features

- `payment-clause-safety` leaves URLs untouched: domain dots stay within a clause, while a period followed by whitespace or end of text separates clauses. Glued commas still separate clauses, and URL removal cannot manufacture a standalone link word. Any negation in a payment-link clause conservatively sends that clause to AI review. Locked by the family-fee unit and real-handler cases, including `negated link below`, `notice URL glued to comma`, and `link glued to URL`; included in `bin/drive-mask-before-llm`.

- `family-fee-notice` sends a transfer request with an unrelated notice link to masked AI review. Merely saying 連結 does not hit the short-link rule. The existing money-transfer-ask detector must match, plus urgency/account language or payment via/at a link in the same bounded clause. Payment-link phrasing alone does not trigger the rule. `lib/family-fee-link.test.js` covers saved/unsaved senders, default context and primary review, retained lures and previously ignored payment phrases; `ties short-link money requests to the payment destination` in `lib/link-rules.test.js` covers clause boundaries and empty input. Included in `bin/drive-mask-before-llm`.


- `lookalike-archive` archives an unsaved chat whose current message contains a lookalike host and AI confirms the scam.
- `lookalike-shapes` hits `whatsapp-secure.com`, a one-character misspelling, a homoglyph, and a `userinfo@evil` URL.
- `allowlist` leaves `sf-express.com`, `hsbc.com.hk`, `wa.me`, `chat.whatsapp.com`, and `whatsapp.com` unflagged.
- `hsbc-regional` sends official UK, China, Australia, and Singapore HSBC domains and their subdomains to mask → LLM without a lookalike rule hit. Lookalikes on unrelated hosts still hit. Covered by `bin/drive-mask-before-llm`.
- `short-solicit` hits a short link only together with an OTP ask, an impersonation claim, or an urgent account-and-money ask. A bare `bit.ly` link does not hit.
- `warning-only-review` in `lib/link-rules.test.js` covers narrative/quoted/English warnings, fake + genuine URLs, all hard-link types, both contact states and both review paths, mask failure, direct asks and repeated flagged links. Included in `bin/drive-mask-before-llm`.
- Short-link solicitation uses coarse flat keywords only (`SOLICIT_HINT_RE` in `lib/link-rules.js`): any shortener host plus a money, credential, login or impersonation word routes the message to masked review. There is no negation stripping or distance binding — a hit never archives or blocks, so precision is the LLM's job, not the regex's.
- `short-link-advice` sends authority mentions and anti-scam advice to mask → LLM, not a rule-only archive. Impersonation requires an affirmative self-identification or a WhatsApp official header, not the bare words 銀行職員 / WhatsApp 官方. Locked by `sends short-link advice and authority mentions to masked AI review` and `flags affirmative impersonation short-link scams for AI review` in `lib/link-rules.test.js`; included in `bin/drive-mask-before-llm`.
- `saved-alert-only` sends a saved contact's lookalike or short-link hit to masked AI review and opens an operator review card only if AI confirms the scam.
- `before-llm` acts on the link rule without waiting for mask/LLM (test names may still say `scorer`).
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

- **Soliciting short link.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'flags a short link only together with OTP, impersonation, or an urgent account ask' \
  lib/link-rules.test.js
```

Exit code `0`. `請提供驗證碼 https://bit.ly/fee` is id `short_link_solicit`. `請轉帳 https://bit.ly/x` does not hit.

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
  --test-name-pattern 'alerts on suspicious saved contacts|family fee' \
  lib/wa-handlers.test.js lib/family-fee-link.test.js
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
