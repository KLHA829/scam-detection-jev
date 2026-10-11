# Link lookalike block

An unsaved contact who sends a lookalike host, or a short link that also asks for a code, impersonates, or urgently demands money, is blocked and the chat is archived. The WhatsApp contact name becomes `封鎖·假域名` or `封鎖·短連結索取`. An allowlisted host such as `sf-express.com` does not hit. A host on `github.io`, `medium.com`, or `blogspot.com` does not hit. A bare `whatsapp-secure.com/login` does. `youtu.be` is not a short link. A saved contact is not auto-blocked.

## Sub-features

- `lookalike-block` blocks an unsaved chat whose current message contains a lookalike host, and names the contact `封鎖·假域名`.
- `lookalike-shapes` hits `whatsapp-secure.com`, a one-character misspelling, a homoglyph, and a `userinfo@evil` URL.
- `allowlist` leaves `sf-express.com`, `hsbc.com.hk`, `wa.me`, `chat.whatsapp.com`, and `whatsapp.com` unflagged.
- `short-solicit` hits a short link only together with an OTP ask, an impersonation claim, or an urgent account-and-money ask. A bare `bit.ly` link does not hit.
- `saved-unblockable` keeps a saved contact at archive when a link rule matches. Auto-block does not run.
- `before-score` acts on the link rule without waiting for the scorer to return.

## How to get to it (user POV)

- Live session: an unsaved number sends a 1:1 message that contains the URL. After the block, the chat-list name is `封鎖·假域名` or `封鎖·短連結索取`, and `blocks.jsonl` gains one JSON line.
- A saved address-book contact who sends the same URL is archived only. The contact is not blocked unless the operator later picks 封鎖並封存 on the guided poll.
- Smoke path: `node --test` on `lib/link-rules.test.js` and the block-policy cases that call `processIncomingMessage` with `savedContact: false` and the in-process benign stub. The link rule fires even when that stub score is 4.

## Driving it with verify-scam-bot

Preconditions:

- Repo root is the working directory.
- `HEURISTIC_ENABLED` is unset (enabled). `BLOCK_ENABLED` is unset (enabled).
- The HTTP stub is not required. These tests construct `createStubJevlikeClient('benign')` in process.
- Do not set `OPERATOR_MODE=guided` in the environment. Guided mode defers the block until the poll; that is the guided-poll feature.

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

- **Unsaved block.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'blocks an unsaved contact on a lookalike domain|blocks an obvious scam without waiting for the scorer|still blocks an unsaved lookalike when the text says' \
  lib/link-rules.test.js lib/block-policy.test.js lib/scam-intent.test.js
```

Exit code `0`. The unsaved lookalike case records contact name `封鎖·假域名` and decision action `block`. The “這不是詐騙” case still blocks.

- **Saved contact stays unblocked.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'archives grey scores and never blocks saved contacts|does not block a saved contact even on a high score' \
  lib/block-policy.test.js
```

Exit code `0`. Action stays `archive`.

- **Proof.** Save TAP to `.cursor/skills/verify-scam-bot/evidence/<UTC-stamp>-link-lookalike-block/node-test.txt`. The file contains `ok` for `blocks an unsaved contact on a lookalike domain` and for `does not flag allowlisted hosts, a bare short link, or a short link with bill-splitting`.

## Gotchas

- The hardcoded hit is the link on the current message. 驗證碼, 轉數快, 封號, USDT, and 順豐清關 wording do not block without a lookalike or a soliciting short link.
- `https://www.sf-express.com/hk` is allowlisted. `https://sf-express-hk.com/pay` is a lookalike.
- `HEURISTIC_ENABLED=0` or `false` turns the link rule off. `BLOCK_ENABLED=false` keeps the archive and skips the block.
- While the first-run setup poll is unanswered, a link-rule chat is archived and nobody is blocked. That wait ends when the operator answers, or when `OPERATOR_MODE` is `auto` or `guided`.
- In guided mode the decision is still `block`, and `processIncomingMessage` does not call the block callback until the operator picks 封鎖並封存.
- A news-style sentence that quotes 封號 or 轉數快 and contains no lookalike URL follows the score. It does not take this block path.
