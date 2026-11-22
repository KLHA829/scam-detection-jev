'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { attachHandlers } = require(path.join(root, 'whatsapp-bot'));
const { createReviewQueue } = require(path.join(root, 'lib/review-queue'));
const { createOperatorState } = require(path.join(root, 'lib/operator-mode'));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-rename-demo-'));
  process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
  try {
    const queue = createReviewQueue({ filePath: path.join(dir, 'queue.json') });
    queue.add({ pollId: 'review', chatId: '9@c.us', digits: '9', contactName: '封鎖·惡意域名', savedContact: false });
    let blocked = false;
    let renameCalled = false;
    let pauses = 0;
    let contact = { isMyContact: false, name: '', async block() { blocked = true; } };
    const chat = { async getContact() { return contact; }, async archive() {}, async mute() {} };
    const client = {
      info: { wid: { _serialized: 'me@c.us' } },
      handlers: {},
      on(event, fn) { this.handlers[event] = fn; },
      async getChatById() { return chat; },
      async saveOrEditAddressbookContact() { renameCalled = true; },
      async sendMessage() { return { id: { _serialized: 'unblock' } }; },
    };
    attachHandlers(client, {
      operator: createOperatorState({ env: {}, filePath: path.join(dir, 'mode.json') }),
      reviewQueue: queue,
      pacer: {
        exclusive: (fn) => fn(),
        async pause() {
          if (++pauses === 2) contact = { ...contact, isMyContact: true, name: 'Alice Chan' };
        },
      },
    });
    await client.handlers.vote_update({
      selectedOptions: [{ name: '封鎖並封存' }],
      parentMessage: { id: { _serialized: 'review' } },
    });
    const log = JSON.parse(fs.readFileSync(process.env.BLOCK_LOG_PATH, 'utf8').trim());
    const [poll] = queue.findOpenUnblock();
    console.log(JSON.stringify({ saveOrEditAddressbookContact: renameCalled, blocked, renamed: log.renamed, savedContact: log.savedContact, unblockSavedContact: poll.savedContact }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
