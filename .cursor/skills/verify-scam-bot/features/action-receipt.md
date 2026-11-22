# Action receipt

After every completed archive or block, the bot messages the operator's own chat. The message names the chat-list contact, the phone, the local reason (link 句式, archive reason, LLM 覆核信心 when present). It has no score line: live inbound uses mask→LLM, not jevlike `/v1/score`, so neither the receipt nor the guided card shows `分數` or `封存線`. Choosing 留低 does not send that receipt.

## Sub-features

- `receipt-archive` starts with `已封存，未封鎖` and includes `左邊：` and `電話：`.
- `receipt-block` starts with `已封鎖並封存` when the block finished, or `封鎖未完成，對話已嘗試封存` when the block did not.
- `receipt-archive-failed` starts with `封存未完成`, or `已封鎖，封存未完成` when the block finished and the archive did not. The receipt still goes out.
- `receipt-phone-missing` writes `電話未解析到` when the number was not resolved, and still names the chat.
- `receipt-guide` adds `模型講解：` only when a guide was requested. A failed mask or a missing model yields `解釋暫時出唔到` and the receipt still goes out.
- `edit-context` removes an edited message's original body before building the receipt or guided explanation, without consuming another slot in the bounded thread buffer. Run `node --test lib/thread-context.test.js`; `node scripts/demo-message-edit.js` prints both explanation paths with an echo-model stub.
- Both raw-text context buffers default to 1000 chats (`maxChats` constructor option, minimum 1). Pushing refreshes recency; exceeding the cap drops the least-recently-pushed chat, never the current one. Reads do not refresh recency. Removing a thread's final body releases that chat. `node scripts/bench-context-buffers.js [checkout-root]` compares retention and push cost using the real buffers in fresh GC-enabled workers.
- `receipt-queue-isolation` prepares automatic explanations outside the WhatsApp write queue. Another chat's link-rule archive does not wait for that mask call; each receipt follows its archive attempt, and a block receipt and its unblock poll stay together in the write queue.
- `ignore-skips-queue` keeps a message that ends in ignore out of the WhatsApp write queue, so it does not wait for another chat's paced block or archive.
- `receipt-leave` answers 留低 with `已留低，冇封存亦冇封鎖。` and does not include the chat-list name.

## How to get to it (user POV)

- Live session: after the bot archives or blocks a DM, open your own WhatsApp chat. The new message is the receipt. The chat-list name is the address-book name for a saved contact, otherwise the push name from before a block renames the contact to `封鎖·…`.
- Guided mode sends the same kind of confirmation after you pick 封鎖並封存 or 只封存. It does not call the model a second time. 留低 sends the one-line leave text.
- Smoke path: `node --test` on `lib/action-notice.test.js`. The tests build the same receipt strings the self-chat sender uses. They do not open WhatsApp.

## Driving it with verify-scam-bot

Preconditions:

- Working directory is the repo root.
- No stub worker is required.
- `LLM_REVIEW_API_URL` may be empty. The tests inject `fetchImpl` or omit the model.

- **Receipt text.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'states who was blocked, the phone, and the local reason|says the phone was not resolved and still names the chat|keeps a local receipt when the model explanation is missing|uses the address-book name for a saved contact|uses the push name before a block renames an unsaved contact' \
  lib/action-notice.test.js
```

Exit code `0`. The block receipt matches `已封鎖並封存`, `左邊：阿明`, and `電話：85290000000`, with no `分數` line. The unresolved-phone receipt matches `已封存，未封鎖` and `電話未解析到`.

- **Queue isolation.** Run `node --test lib/receipt-latency.test.js`. A second chat archives within 150 ms while the first receipt's 250 ms mask call is pending. Success, failed mask, and failed archive cases retain their receipts and archive-before-receipt order. Reproduce medians with `node scripts/bench-receipt-latency.js` (five runs each at 0, 250, and 1000 ms mask delay).

- **Ignore skips the write queue.** Run `node --test --test-name-pattern "does not queue an ignored message" lib/action-pacer.test.js`. Exit code `0`: two ignored messages from one chat return while another chat's write holds the queue, and `exclusive` is never called. Reproduce medians with `node scripts/bench-ignore-latency.js` (three runs each at 1000 and 3000 ms `WA_ACTION_GAP_MS`).

- **Name and phone stay off the chat API.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'sends only the desensitised transcript to the chat API' \
  lib/action-notice.test.js
```

Exit code `0`. The request body contains `XXX` and does not contain `91234567`, `陳大文`, or the chat-list name and phone that appear on the receipt.

- **Leave does not receipt the identity.** Run:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'adds the local identity after archive or block and does not add a model section' \
  lib/action-notice.test.js
```

Exit code `0`. The 只封存 text matches `已封存，未封鎖` and `左邊：阿明`. The 留低 text is exactly `已留低，冇封存亦冇封鎖。`

- **Proof.** Save TAP to `evidence/<UTC-stamp>-action-receipt/node-test.txt`. The archive/block cases show the headline and the `左邊：` line. The leave case shows the one-line text.

## Gotchas

- The optional Cantonese paragraph uses the masked transcript only. The name and the phone are appended on this machine. A failed mask still sends the receipt, with `解釋暫時出唔到`.
- The model section is absent on a guided confirmation. That confirmation repeats the name, phone, and local reason and does not call the model again.
- A receipt is not proof that WhatsApp accepted the message. The offline tests assert the string `buildActionNotice` and `applyReviewChoice` produce. A live send requires `[OK] WhatsApp client ready`.
- Choosing 留低 does not archive, block, or include the chat-list name.
