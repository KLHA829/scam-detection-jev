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
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('action pacer', () => {
  it('spaces WhatsApp mutations and skips a chat it already changed', async () => {
    const clock = fakeClock();
    const pacer = createActionPacer({
      env: { WA_ACTION_GAP_MS: '3000', BLOCK_MAX_PER_HOUR: '6', ACTION_REPEAT_MS: '60000' },
      now: clock.now,
      sleep: clock.sleep,
    });

    const first = pacer.evaluate({ action: 'block', chatId: 'a@c.us', digits: '8521' });
    assert.equal(first.proceed, true);
    assert.equal(first.action, 'block');
    await pacer.pause();
    assert.equal(clock.now(), 1_000_000);
    await pacer.pause();
    assert.equal(clock.now(), 1_003_000);
    pacer.note({ action: 'block', chatId: 'a@c.us', digits: '8521' });

    const again = pacer.evaluate({ action: 'block', chatId: 'a@c.us', digits: '8521' });
    assert.equal(again.proceed, false);
    assert.equal(again.reason, 'already_acted');
  });

  it('turns extra blocks into a single archive once the hourly cap is full', () => {
    const clock = fakeClock();
    const pacer = createActionPacer({
      env: { BLOCK_MAX_PER_HOUR: '1', WA_ACTION_GAP_MS: '0' },
      now: clock.now,
      sleep: clock.sleep,
    });
    const allowed = pacer.evaluate({ action: 'block', chatId: 'a@c.us', digits: '1' });
    assert.equal(allowed.action, 'block');
    pacer.note({ action: 'block', chatId: 'a@c.us', digits: '1' });

    const capped = pacer.evaluate({ action: 'block', chatId: 'b@c.us', digits: '2' });
    assert.equal(capped.proceed, true);
    assert.equal(capped.action, 'archive');
    assert.equal(capped.reason, 'hourly_cap');
    pacer.note({ action: 'archive', chatId: 'b@c.us', digits: '2' });

    const repeat = pacer.evaluate({ action: 'block', chatId: 'b@c.us', digits: '2' });
    assert.equal(repeat.proceed, false);
  });

  it('treats a previous blocks.jsonl hit as already blocked', () => {
    const pacer = createActionPacer({
      env: { BLOCK_MAX_PER_HOUR: '6' },
      logPath: 'blocks.jsonl',
      readFile: () =>
        `${JSON.stringify({
          blocked: true,
          digits: '85260000000',
          chatId: '85260000000@c.us',
          at: '2026-09-21T00:00:00.000Z',
        })}\n`,
    });
    const out = pacer.evaluate({
      action: 'block',
      chatId: '85260000000@c.us',
      digits: '85260000000',
    });
    assert.equal(out.proceed, false);
    assert.equal(out.reason, 'already_acted');
  });

  it('skips a contact WhatsApp already marks blocked', () => {
    const pacer = createActionPacer({
      env: { BLOCK_MAX_PER_HOUR: '6', WA_ACTION_GAP_MS: '0' },
    });
    const out = pacer.evaluate({
      action: 'block',
      chatId: 'x@c.us',
      digits: '8529',
      alreadyBlocked: true,
    });
    assert.equal(out.proceed, false);
  });
});

describe('paced block flow', () => {
  it('pauses between rename, block, and mute', async () => {
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
    assert.deepEqual(calls, ['pause', 'rename', 'pause', 'block', 'pause', 'mute']);
  });

  it('does not touch WhatsApp again for a second message from the same chat', async () => {
    const pacer = createActionPacer({
      env: { WA_ACTION_GAP_MS: '0', BLOCK_MAX_PER_HOUR: '6', ACTION_REPEAT_MS: '60000' },
    });
    let blocks = 0;
    let archives = 0;
    const deps = {
      scoreClient: createStubJevlikeClient(),
      rubric,
      exclusive: (fn) => pacer.exclusive(fn),
      paceAction: (info) => pacer.evaluate(info),
      pauseAction: () => pacer.pause(),
      noteAction: (info) => pacer.note(info),
      resolveNumber: async () => ({ digits: '85269990000', unresolvedLid: false }),
      archiveChat: async () => {
        archives += 1;
      },
      blockContact: async () => {
        blocks += 1;
        return { renamed: true, blocked: true, muted: true, errors: [] };
      },
      recordBlock: async () => {},
    };
    const input = {
      type: 'chat',
      body: '[stub:scam] 請睇下',
      chatId: '85269990000@c.us',
      savedContact: false,
      messageId: 'pace-1',
    };
    const first = await processIncomingMessage(input, deps);
    const second = await processIncomingMessage(
      { ...input, messageId: 'pace-2' },
      deps,
    );
    assert.equal(first.decision.action, 'block');
    assert.equal(second.decision.action, 'ignore');
    assert.equal(second.decision.paceSkipped, 'already_acted');
    assert.equal(blocks, 1);
    assert.equal(archives, 1);
  });

  it('archives instead of blocking after the hourly cap', async () => {
    const pacer = createActionPacer({
      env: { WA_ACTION_GAP_MS: '0', BLOCK_MAX_PER_HOUR: '1' },
    });
    const blocked = [];
    const archived = [];
    function deps(digits) {
      return {
        scoreClient: createStubJevlikeClient(),
        rubric,
        exclusive: (fn) => pacer.exclusive(fn),
        paceAction: (info) => pacer.evaluate(info),
        pauseAction: () => pacer.pause(),
        noteAction: (info) => pacer.note(info),
        resolveNumber: async () => ({ digits, unresolvedLid: false }),
        archiveChat: async () => archived.push(digits),
        blockContact: async () => {
          blocked.push(digits);
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      };
    }
    const a = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 第一',
        chatId: '1@c.us',
        savedContact: false,
        messageId: 'cap-1',
      },
      deps('1'),
    );
    const b = await processIncomingMessage(
      {
        type: 'chat',
        body: '[stub:scam] 第二',
        chatId: '2@c.us',
        savedContact: false,
        messageId: 'cap-2',
      },
      deps('2'),
    );
    assert.equal(a.decision.action, 'block');
    assert.equal(b.decision.action, 'archive');
    assert.equal(b.decision.blockDeferred, 'hourly_cap');
    assert.deepEqual(blocked, ['1']);
    assert.deepEqual(archived, ['1', '2']);
  });
});
