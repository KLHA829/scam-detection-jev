'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBotContactNames } = require('./bot-contact-names');

describe('bot contact names', () => {
  it('survive a restart and match only the number and name the bot wrote', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-names-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'bot-contact-names.json');
    createBotContactNames({ filePath }).record('+852 6123 4567', '（可疑推銷）');

    const names = createBotContactNames({ filePath });
    assert.equal(names.wrote({ number: '85261234567', name: '（可疑推銷）' }), true);
    assert.equal(names.wrote({ id: { user: '85261234567' }, name: '（可疑推銷）' }), true);
    assert.equal(names.wrote({ number: '85261234567', name: 'Ada' }), false);
    assert.equal(names.wrote({ number: '85269999999', name: '（可疑推銷）' }), false);
    assert.equal(names.wrote({ name: '（可疑推銷）' }), false);
  });

  it('keeps working in memory when the file cannot be written', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-names-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const names = createBotContactNames({ filePath: path.join(blocker, 'names.json') });
    names.record('85261234567', '封鎖·惡意域名');
    assert.equal(names.wrote({ number: '85261234567', name: '封鎖·惡意域名' }), true);
  });
});
