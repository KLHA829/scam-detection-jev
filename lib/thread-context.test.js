'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createThreadContext } = require('./thread-context');
const { processIncomingMessage } = require('./handle-incoming');
const { createStubJevlikeClient } = require('../stub-jevlike');
const { llmOffDeps } = require('./test-llm');

describe('thread window', () => {
  it('evicts the least recently pushed chat without changing the message cap', () => {
    const thread = createThreadContext({ turns: 3, maxChats: 2 });
    thread.push('a', 'one');
    thread.push('b', 'other');
    thread.push('a', 'two');
    thread.push('a', 'three');
    thread.prior('b');
    thread.push('c', 'new');
    assert.deepEqual(thread.prior('b'), []);
    assert.deepEqual(thread.prior('a'), ['two', 'three']);
    assert.deepEqual(thread.prior('c'), ['new']);
  });

  it('retains the pushed chat with a minimum capacity of one', () => {
    for (const maxChats of [1, 0, -1, 0.5]) {
      const thread = createThreadContext({ maxChats });
      thread.push('a', 'old');
      thread.push('b', 'new');
      thread.push('b', '');
      thread.push('', 'ignored');
      assert.deepEqual(thread.prior('a'), []);
      assert.deepEqual(thread.prior('b'), ['new']);
    }
  });

  it('drops empty chats after removal so they do not consume capacity', () => {
    const thread = createThreadContext({ maxChats: 2 });
    thread.push('a', 'keep');
    thread.push('b', 'remove');
    thread.remove('b', 'remove');
    thread.push('c', 'new');
    assert.deepEqual(thread.prior('a'), ['keep']);
    assert.deepEqual(thread.prior('b'), []);
    assert.deepEqual(thread.prior('c'), ['new']);
  });

  it('removes only the latest matching body and tolerates missing or empty edits', () => {
    const thread = createThreadContext({ turns: 5 });
    thread.remove('missing', 'old');
    thread.push('c', 'same');
    thread.push('c', 'middle');
    thread.push('c', 'same');
    thread.remove('c', '');
    thread.remove('c', null);
    thread.remove('c', 'missing');
    assert.deepEqual(thread.prior('c'), ['same', 'middle', 'same']);
    thread.remove('c', ' same ');
    assert.deepEqual(thread.prior('c'), ['same', 'middle']);
    assert.deepEqual(thread.prior('missing'), []);
  });

  for (const operatorMode of ['auto', 'guided']) {
    it(`replaces edited text in ${operatorMode} explanation context without evicting earlier messages`, async () => {
      const thread = createThreadContext({ turns: 4 });
      const deps = llmOffDeps({ threadContext: thread, operatorMode });
      const send = (body, messageId, editedFrom) => processIncomingMessage(
        { type: 'chat', chatId: `edit-${operatorMode}@c.us`, body, messageId },
        { ...deps, editedFrom },
      );
      await send('earlier one', '1');
      await send('earlier two', '2');
      const original = 'original https://malicious-block-test.invalid';
      const edited = 'edited https://malicious-block-test.invalid';
      await send(original, '3');
      const out = await send(edited, '3', original);
      assert.deepEqual(out.reviewMessages, ['earlier one', 'earlier two', edited]);
      assert.deepEqual(thread.prior(`edit-${operatorMode}@c.us`), ['earlier one', 'earlier two', edited]);
      const next = await send('next https://malicious-block-test.invalid', '4');
      assert.deepEqual(next.reviewMessages, ['earlier one', 'earlier two', edited, 'next https://malicious-block-test.invalid']);
    });
  }

  it('stores only CONTEXT_TURNS - 1 prior messages', () => {
    const thread = createThreadContext({ turns: 4 });
    thread.push('c', 'one');
    thread.push('c', 'two');
    thread.push('c', 'three');
    thread.push('c', 'four');
    assert.deepEqual(thread.prior('c'), ['two', 'three', 'four']);
  });
});

describe('thread context on the inbound path', () => {
  it('inbound path does not call jevlike score (thread kept for review copy only)', async () => {
    const thread = createThreadContext({ turns: 4 });
    let scoreCalls = 0;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '我係順豐客服',
        chatId: 'split@c.us',
        savedContact: false,
        messageId: 'split-1',
      },
      llmOffDeps({
        threadContext: thread,
        maskClient: {
          async scoreText() {
            scoreCalls += 1;
            return { prob_scam: 0.9 };
          },
          async maskMessages(messages) {
            return createStubJevlikeClient().maskMessages(messages);
          },
        },
      }),
    );
    assert.equal(scoreCalls, 0);
    assert.equal(out.scoreSource, 'llm_primary');
    assert.equal(out.decision.action, 'ignore');
  });
});
