'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReviewQueue } = require('./review-queue');
const { attachHandlers } = require('../whatsapp-bot');

for (const kind of ['review', 'unblock']) {
  it(`${kind} consumption survives a failed save and notifies the operator`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-save-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'q.json');
    const queue = createReviewQueue({ filePath });
    assert.equal(queue.consume('missing'), null);
    queue.add({ kind, pollId: 'p', chatId: 'chat', resolved: false });
    const before = queue.get('p');
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    assert.throws(() => queue.consume('p'));
    assert.equal(queue.get('p'), before);
    assert.equal(queue.get('p').resolved, false);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).items.p.resolved, false);
    const sent = [];
    let actions = 0;
    const client = {
      info: { wid: { _serialized: 'me@c.us' } }, handlers: {},
      on(event, fn) { this.handlers[event] = fn; },
      sendMessage: async (_id, text) => { sent.push(text); },
      getChatById: async () => { actions++; throw new Error('must not act'); },
    };
    attachHandlers(client, {
      operator: {}, reviewQueue: queue,
      pacer: { exclusive: (fn) => fn() },
    });
    await client.handlers.vote_update({
      parentMessage: { id: { _serialized: 'p' } },
      selectedOptions: [{ name: kind === 'unblock' ? '解除封鎖' : '只封存' }],
    });
    assert.equal(actions, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /儲存選擇失敗/);
    assert.equal(queue.get('p').resolved, false);
    fs.rmdirSync(tmp);
    assert.equal(queue.consume('p').resolved, true);
    assert.equal(queue.consume('p'), null);
    assert.equal(createReviewQueue({ filePath }).get('p').resolved, true);
  });
}
