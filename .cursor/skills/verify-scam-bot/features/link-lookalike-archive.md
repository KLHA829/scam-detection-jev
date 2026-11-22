# Link lookalike archive (no auto-block)

An unsaved contact who sends a lookalike host, or a short link that also asks for a code, impersonates, or urgently demands money, is **archived** (`obvious_scam`) and the operator gets the usual self-chat receipt. Auto-block does **not** run on these heuristics (elderly precision-first). An allowlisted host such as `sf-express.com` does not hit. A host on `github.io`, `medium.com`, or `blogspot.com` does not hit. A bare `whatsapp-secure.com/login` does. `youtu.be` is not a short link. A saved contact is not auto-blocked.

## Sub-features

- `lookalike-archive` archives an unsaved chat whose current message contains a lookalike host; decision action stays `archive`.
- `lookalike-shapes` hits `whatsapp-secure.com`, a one-character misspelling, a homoglyph, and a `userinfo@evil` URL.
- `allowlist` leaves `sf-express.com`, `hsbc.com.hk`, `wa.me`, `chat.whatsapp.com`, and `whatsapp.com` unflagged.
- `hsbc-regional` sends official UK, China, Australia, and Singapore HSBC domains and their subdomains to mask → LLM instead of hard-archiving them. Lookalikes on unrelated hosts still hit. Covered by `bin/drive-mask-before-llm`.
- `short-solicit` hits a short link only together with an OTP ask, an impersonation claim, or an urgent account-and-money ask. A bare `bit.ly` link does not hit.
- `direct-harvest-credential` requires a direct forwarding verb and a nearby credential in the same clause. `send 相片畀我。今日改咗密碼。 https://bit.ly/photo` goes to mask → LLM; `send 你個密碼畀我`, `將驗證碼發給我`, `send me your OTP`, and `轉發驗證碼` with short links still hard-archive. The `direct harvest credential binding` suite in `lib/scam-intent.test.js` covers unit signals, real-handler routing, empty input, and mask failure; included in `bin/drive-mask-before-llm`.
- `short-link-advice` sends authority mentions and anti-scam advice to mask → LLM, not a rule-only archive. Impersonation requires an affirmative self-identification or a WhatsApp official header, not the bare words 銀行職員 / WhatsApp 官方. Locked by `sends short-link advice and authority mentions to masked AI review` and `keeps affirmative impersonation short-link scams on the hard archive path` in `lib/link-rules.test.js`; included in `bin/drive-mask-before-llm`.
- `saved-unblockable` keeps a saved contact at archive when a link rule matches. Auto-block does not run.
- `before-llm` acts on the link rule without waiting for mask/LLM (test names may still say `scorer`).
- Advice remains fail-closed on mask errors (`fails closed when masking short-link advice fails`, also in `bin/drive-mask-before-llm`).

## How to get to it (user POV)

- Live session: an unsaved number sends a 1:1 message that contains the URL. The chat is archived; the contact is not renamed with `封鎖·` unless the URL is also on the malicious-host list (see [malicious-host-block](./malicious-host-block.md)).
- A saved address-book contact who sends the same URL is archived only. Block requires an explicit **封鎖並封存** on the guided poll.
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
  --test-name-pattern 'archives an unsaved lookalike without auto-block|archives a lookalike without blocking|still archives an unsaved lookalike when the text says' \
  lib/link-rules.test.js lib/block-policy.test.js lib/scam-intent.test.js
```

Exit code `0`. Decision action is `archive`; `blockContact` is not called.

- **Saved contact stays unblocked.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'archives grey scores and never blocks saved contacts|does not block a saved contact even on a high score' \
  lib/block-policy.test.js
```

Exit code `0`. Action stays `archive`.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-link-lookalike-archive/node-test.txt`. The file contains `ok` for `archives an unsaved lookalike without auto-block` and for `does not flag allowlisted hosts, a bare short link, or a short link with bill-splitting`.

## Gotchas

- The hardcoded hit is the link on the current message. 驗證碼, 轉數快, 封號, USDT, and 順豐清關 wording do not archive without a link rule or score.
- `https://www.sf-express.com/hk` is allowlisted. `https://sf-express-hk.com/pay` is a lookalike.
- `HEURISTIC_ENABLED=0` or `false` turns the link rule off.
- While the first-run setup poll is unanswered, a link-rule chat is archived and nobody is blocked (except malicious-host list; see malicious-host-block).
- In guided mode the decision is `archive`, and `processIncomingMessage` does not call archive until the operator picks **只封存** or **封鎖並封存**.
- Auto-block is only for URLs on `data/malicious-hosts.json`, not for lookalike heuristics.
