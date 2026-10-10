'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createActionPacer } = require('./action-pacer');
const { blockAndRename } = require('./wa-actions');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');
const { createStubJevlikeClient } = require('../stub-jevlike');

const rubric = loadRubric();

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

describe('action pacer', () => {
  it('waits WA_ACTION_GAP_MS between calls and runs one chat at a time', async () => {
    const clock = fakeClock();
    const pacer = createActionPacer({
      env: { WA_ACTION_GAP_MS: '3000' },
      now: clock.now,
      sleep: clock.sleep,
    });
    const order = [];
    const a = pacer.exclusive(async () => {
      order.push('a-start');
      await pacer.pause();
      order.push('a-1');
      await pacer.pause();
      order.push('a-2');
    });
    const b = pacer.exclusive(async () => {
      order.push('b-start');
      await pacer.pause();
      order.push('b-1');
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-1', 'a-2', 'b-start', 'b-1']);
    assert.equal(clock.now(), 1_006_000);
  });
});

describe('paced block flow', () => {
  it('pauses between block, rename, and mute', async () => {
    let pauses = 0;
    const calls = [];
    await blockAndRename({
      client: {
        async saveOrEditAddressbookContact() {
          calls.push('rename');
        },
      },
      contact: {
        async block() {
          calls.push('block');
        },
      },
      chat: {
        async mute() {
          calls.push('mute');
        },
      },
      digits: '85211112222',
      contactName: '封鎖·高分90',
      pause: async () => {
        pauses += 1;
        calls.push('pause');
      },
    });
    assert.equal(pauses, 3);
    assert.deepEqual(calls, ['pause', 'block', 'pause', 'rename', 'pause', 'mute']);
  });

  it('still archives a later message from the same chat, one chat at a time', async () => {
    const clock = fakeClock();
    const pacer = createActionPacer({
      env: { WA_ACTION_GAP_MS: '3000' },
      now: clock.now,
      sleep: clock.sleep,
    });
    const archived = [];
    function deps(digits, chatId) {
      return {
        scoreClient: createStubJevlikeClient(),
        rubric,
        exclusive: (fn) => pacer.exclusive(fn),
        pauseAction: () => pacer.pause(),
        resolveNumber: async () => ({ digits, unresolvedLid: false }),
        archiveChat: async () => {
          archived.push(chatId);
        },
        blockContact: async () => {
          throw new Error('hardcoded phrase must not block');
        },
        recordBlock: async () => {},
      };
    }
    const first = processIncomingMessage(
      {
        type: 'chat',
        body: '請用轉數快立即轉帳到此帳戶 第一',
        chatId: '1@c.us',
        savedContact: false,
        messageId: 'pace-1',
      },
      deps('1', '1@c.us'),
    );
    const second = processIncomingMessage(
      {
        type: 'chat',
        body: '請用轉數快立即轉帳到此帳戶 第二',
        chatId: '1@c.us',
        savedContact: false,
        messageId: 'pace-2',
      },
      deps('1', '1@c.us'),
    );
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.decision.action, 'archive');
    assert.equal(b.decision.action, 'archive');
    assert.deepEqual(archived, ['1@c.us', '1@c.us']);
    assert.equal(clock.now(), 1_003_000);
  });
});
