# Guided poll

In guided mode the bot forwards a suspicious DM to the operator's own chat, explains it only after `POST /v1/mask`, and waits. Nothing is archived or blocked until the operator picks 封鎖並封存, 只封存, or 留低. The explanation model cannot press a choice.

## Sub-features

- `setup-poll` asks `呢個 bot 點處理可疑訊息？` with 自動封鎖同封存 and 逐條問我. Until that poll is answered, suspicious chats are archived and nobody is blocked. `OPERATOR_MODE=auto` or `OPERATOR_MODE=guided` skips the question. Sending `設定` in the operator's own chat asks again.
- `review-poll` asks `你想點處理？` with 封鎖並封存, 只封存, and 留低. Numeric replies `1`, `2`, and `3` map to those three choices.
- `guided-defer` computes the decision and does not call archive or block until the choice arrives.
- `mask-fail-poll` still shows the poll when the mask or the model fails. The card says `解釋暫時出唔到`.
- `first-choice` runs the first answer and ignores a second one. 封鎖並封存 is the choice that blocks a saved contact.

## How to get to it (user POV)

- On the first ready session the bot posts the setup poll to your own chat. Pick 逐條問我, or set `OPERATOR_MODE=guided` before `npm start`.
- When a suspicious 1:1 DM arrives, your own chat receives the forwarded message, a local facts card (score, lure label, what would have happened), and the poll `你想點處理？`.
- Pick one option, or reply `1` / `2` / `3` while quoting the poll. The first answer is the one that runs.
- Smoke path: `node --test` on `lib/operator-review.test.js`. The tests call `deliverGuidedReview`, `parseReviewChoice`, and `processIncomingMessage` with `operatorMode: 'guided'`. They do not open WhatsApp.

## Driving it with verify-scam-bot

Preconditions:

- Working directory is the repo root.
- No stub HTTP worker is required. Tests use the in-process stub client or a mask function that throws.
- Leave `OPERATOR_MODE` unset in the shell unless a case sets it inside the test.

- **Poll labels.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'maps poll labels and numeric replies|lets OPERATOR_MODE pin the choice and skip setup|keeps automatic handling until a choice is stored' \
  lib/operator-review.test.js
```

Exit code `0`. `封鎖並封存` is `block`, `2` is `archive`, `3 留低` is `leave`, `逐條問我` is `guided`.

- **Defer the action.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'does not archive or block, and returns the bodies to desensitise|leaves an ordinary message alone' \
  lib/operator-review.test.js
```

Exit code `0`. The lookalike DM returns `deferred: true`, decision action `block`, and empty archive/block callback lists. An ordinary DM is left alone.

- **Poll survives a failed mask.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'still offers the poll when the explanation is unavailable|keeps the card when the model fails|still offers the poll$' \
  lib/operator-review.test.js
```

Exit code `0`. The card text matches `解釋暫時出唔到`. `sendPoll` may throw; the text card is still sent and the queue item stays unresolved.

- **First choice wins.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'executes the first choice and ignores a second one' \
  lib/operator-review.test.js
```

Exit code `0`. The first 封鎖並封存 confirmation matches `已封鎖並封存`. A later choice does not run.

- **Proof.** Save TAP to `evidence/<UTC-stamp>-operator-guided-poll/node-test.txt`. It includes `ok` for `does not archive or block, and returns the bodies to desensitise` and for `still offers the poll when the explanation is unavailable`.

## Gotchas

- The explanation is requested only after `/v1/mask`. A failed mask skips the explanation and still shows the poll. The model cannot archive, block, or hide the card.
- An explicit 封鎖並封存 is the only path that blocks a saved contact. Link rules and the context model do not.
- The first choice on a review poll is the one that runs. A second vote is ignored.
- Until the setup poll is answered, the bot archives and does not block. That is a different wait from guided mode, which archives nothing until you choose.
- `自動封鎖同封存` is today's automatic path: link rules and an explicit context-model `block` still block unsaved contacts, and a score only archives. The receipt feature then messages your own chat.
- Replying `今日食飯` does not select a choice.
