'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUserRestoredChats, defaultUserRestoredChatsPath } = require('./user-restored-chats');

describe('user-restored chats store', () => {
  it('defaults next to the working directory and honours USER_RESTORED_CHATS_PATH', () => {
    assert.equal(defaultUserRestoredChatsPath({}), path.join(process.cwd(), 'user-restored-chats.json'));
    assert.equal(defaultUserRestoredChatsPath({ USER_RESTORED_CHATS_PATH: '/x/r.json' }), '/x/r.json');
  });

  it('keeps a restore in memory when the file cannot be written', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parent = path.join(dir, 'not-a-directory');
    fs.writeFileSync(parent, '');
    const store = createUserRestoredChats({ filePath: path.join(parent, 'restored.json') });
    store.record('85261110000@c.us');
    assert.equal(store.has('85261110000@c.us'), true);
    assert.equal(store.has('85261110001@c.us'), false);
  });

  it('ignores a corrupt file', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'restored.json');
    fs.writeFileSync(file, '{not json');
    assert.equal(createUserRestoredChats({ filePath: file }).has('85261110000@c.us'), false);
  });
});
