# Guided poll

In guided mode the bot forwards a suspicious DM to the operator's own chat, explains it only after `POST /v1/mask`, and waits. Nothing is archived or blocked until the operator picks 封鎖並封存, 只封存, or 留低. The explanation model cannot press a choice.

## Guided explanation queue isolation

`node --test lib/guided-latency.test.js` locks slow mask/LLM isolation from other
chats' archives, same-chat delivery order, exclusive writes with no added pauses,
concurrent duplicate claims, and retry after delivery produces no poll. `node scripts/bench-guided-latency.js`
measures the same two-chat path with fixed mask/LLM latency.

## Sub-features

- `self-chat-only` accepts operator commands and quoted poll replies only in the operator's own phone/LID chat, never another chat just because the sender is me. `handles operator text commands only in self chat` and `checks self-chat identity:` in `lib/wa-handlers.test.js` cover cross-chat unblock rejection, own-LID mapping, unrelated/empty mappings, and lookup failure; both run in `bin/drive-agents-invariants`.
- `setup-poll` asks `呢個 bot 點處理可疑訊息？` with 自動封鎖同封存 and 逐條問我. Until that poll is answered, suspicious chats are archived and nobody is blocked. `OPERATOR_MODE=auto` or `OPERATOR_MODE=guided` skips the question. Sending `設定` in the operator's own chat asks again.
- `review-poll` asks `你想點處理？` with 封鎖並封存, 只封存, and 留低. Numeric replies `1`, `2`, and `3` map to those three choices.
- `current-setup-poll` accepts mode changes only from the most recently sent setup poll, including after a choice or restart. Superseded setup polls are void.
- `guided-defer` computes the decision and does not call archive or block until the choice arrives.
- `mask-fail-poll` still shows the poll when the mask or the model fails. The card says `解釋暫時出唔到`.
- `malformed-guide` rejects non-string or empty model explanations without coercing objects or arrays into card text. Run `node --test --test-name-pattern='uses fallback text for malformed guided explanations' lib/operator-review.test.js`; the card says `解釋暫時出唔到` and still offers the poll.
- `first-choice` runs the first answer and ignores a second one. 封鎖並封存 is the choice that blocks a saved contact.
- `live-contact-name` preserves a contact saved or named after the poll was sent while still blocking on explicit confirmation. Unsaved contacts keep the bot label; a second pending poll recognises that temporary label and retains unblock cleanup metadata.
- `sibling-unblock-polls` closes all pending unblock polls for the same chat when either 解除封鎖 or 保持封鎖 is chosen. Later votes and bare 解除 cannot act through those closed polls.
- `edit-voids-poll` voids the open review poll when the sender edits the message. A vote or quoted reply on the old poll does nothing and gets `呢個投票已作廢`. The edited text is reviewed again and gets a new poll only if it is still suspicious.

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

- **Current setup poll only.** Run `node --test --test-name-pattern='ignores superseded setup polls' lib/wa-handlers.test.js`. The actual client vote handler ignores old polls and accepts the current poll across restarts.

- **Defer the action.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'does not archive or block, and returns the bodies to desensitise|leaves an ordinary message alone' \
  lib/operator-review.test.js
```

Exit code `0`. The lookalike DM returns `deferred: true`, decision action `archive`, and empty archive/block callback lists. An ordinary DM is left alone.

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

- **Live contact names and repeated guided blocks.** Run:

```bash
node --test lib/guided-block-name.test.js
```

Exit code `0`. Live saved names survive explicit blocks, unsaved contacts are renamed,
and unblock deletes the temporary contact even after two pending polls both block it.
These cases also run in `bin/drive-agents-invariants` as part of the CI smoke.

- **Sibling unblock polls close together.** Run:

```bash
node --test lib/sibling-unblock-polls.test.js
```

Exit code `0`. Real client handlers with WhatsApp stubbed create two guided blocks
for one chat. Either unblock-poll answer closes its sibling, so a later vote or
bare 解除 cannot reuse it. The handler cases isolate pending polls from the separate
block-history fallback with a temporary `BLOCK_LOG_PATH`. Queue cases cover
restart persistence, unrelated polls, new blocks, failed saves, action retry,
and missing or chatless polls. All six cases also run in
`bin/drive-agents-invariants` as part of the CI smoke.

- **Contact renamed during unblock pacing.** Run:

```bash
node --test --test-name-pattern='does not delete a contact renamed during the wait before deletion' lib/wa-actions.test.js
```

Exit code `0`. A user rename while unblock waits before deletion is preserved;
unblock and unmute still run. This also runs in `bin/drive-agents-invariants`.

- **Unblock command history.** Run:

```bash
node --test --test-name-pattern='limits successful block history only after filtering failed attempts|uses the newest successful reblock metadata while preserving open poll priority' lib/operator-commands.test.js
```

Exit code `0`. Failed attempts do not consume the successful-block history limit.
Number-based unblock commands use the newest successful rename metadata per chat;
an open unblock poll still takes priority.

- **Edit voids the old poll.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'voids the guided poll when its message is edited|re-reviews an edited model-flagged DM|does not let the context review|voids only the open review polls' \
  lib/wa-handlers.test.js lib/unblock-poll.test.js
```

Exit code `0`. After an edit to `Hello`, 只封存 on the old poll archives nothing and the reply matches `作廢`. Editing back to the lookalike link opens a new poll.
A failed queue write leaves the old poll unresolved in the queue but rejects stale votes in the running bot. Retrying the edit after storage recovers saves the void and re-reviews the edited text despite the LLM cooldown.

- **Proof.** Save TAP to `evidence/<UTC-stamp>-operator-guided-poll/node-test.txt`. It includes `ok` for `does not archive or block, and returns the bodies to desensitise` and for `still offers the poll when the explanation is unavailable`.

## Gotchas

- **Block failure still archives.** `node .cursor/skills/verify-scam-bot/bin/drive-guided-block-failure`
  drives the real vote handler with a throwing block and both successful and failed archives.
  Receipts distinguish the archive outcome and neither case offers an unblock poll.
  Pass another checkout path to drive that version (`EXPECT_BEFORE=1` disables fixed-outcome assertions).
  Regression: `node --test --test-name-pattern='archives after block throws' lib/operator-review.test.js`.

- The explanation is requested only after `/v1/mask`. A failed mask skips the explanation and still shows the poll. The model cannot archive, block, or hide the card.
- An explicit 封鎖並封存 is the only path that blocks a saved contact. Link heuristics and models do not auto-block.
- The first choice on a review poll is the one that runs. A second vote is ignored.
- An edit voids the open poll for that message. Unblock polls are not touched.
- Until the setup poll is answered, the bot archives and does not block. That is a different wait from guided mode, which archives nothing until you choose.
- `自動封鎖同封存` is today's automatic path: malicious-host list may block unsaved contacts; lookalike/short-link and scores archive only. The receipt feature then messages your own chat.
- Replying `今日食飯` does not select a choice.
