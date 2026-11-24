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

  it('backs up corrupt files and refuses to clobber on transient read errors', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'restored.json');
    fs.writeFileSync(file, '{not json');
    const recovered = createUserRestoredChats({ filePath: file });
    assert.equal(recovered.has('85261110000@c.us'), false);
    assert.ok(fs.readdirSync(dir).some((entry) => entry.startsWith('restored.json.corrupt.')));
    recovered.record('85261110000@c.us');
    assert.equal(createUserRestoredChats({ filePath: file }).has('85261110000@c.us'), true);

    const eisdirTarget = path.join(dir, 'as-dir');
    fs.mkdirSync(eisdirTarget);
    const blocked = createUserRestoredChats({ filePath: eisdirTarget });
    assert.doesNotThrow(() => blocked.record('85261119999@c.us'));
    assert.equal(blocked.has('85261119999@c.us'), true);
  });

  it('keeps newer restores ahead of recovered disk entries when disk file is at capacity', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-full-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'restored.json');
    fs.mkdirSync(file);

    const store = createUserRestoredChats({ filePath: file });
    store.record('new-chat@c.us');

    fs.rmdirSync(file);
    const existing = Array.from({ length: 5000 }, (_, i) => `chat-${i}@c.us`);
    fs.writeFileSync(file, `${JSON.stringify({ chatIds: existing })}\n`, 'utf8');

    store.record('newest@c.us');

    assert.equal(store.has('new-chat@c.us'), true);
    assert.equal(store.has('newest@c.us'), true);
    assert.equal(store.has('chat-0@c.us'), false);
    assert.equal(store.has('chat-1@c.us'), false);
    assert.equal(store.has('chat-2@c.us'), true);

    const reloaded = createUserRestoredChats({ filePath: file });
    assert.equal(reloaded.has('new-chat@c.us'), true);
    assert.equal(reloaded.has('newest@c.us'), true);
    assert.equal(reloaded.has('chat-0@c.us'), false);
    assert.equal(reloaded.has('chat-1@c.us'), false);
    assert.equal(reloaded.has('chat-4999@c.us'), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).chatIds.length, 5000);
  });
});
