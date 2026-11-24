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
    createBotContactNames({ filePath }).record(null, '+852 6123 4567', '（可疑推銷）');
    createBotContactNames({ filePath }).record({ id: { _serialized: '12345@lid' } }, '85260000000', '（可疑推銷）');

    const names = createBotContactNames({ filePath });
    const contact = (id, name = '（可疑推銷）') => ({ id: { _serialized: id }, name });
    assert.equal(names.wrote(contact('85261234567@c.us')), true);
    assert.equal(names.wrote(contact('12345@lid')), true);
    assert.equal(names.wrote(contact('85260000000@c.us')), true);
    assert.equal(names.wrote(contact('85261234567@c.us', 'Ada')), false);
    assert.equal(names.wrote(contact('85269999999@c.us')), false);
    assert.equal(names.wrote({ number: '85261234567', name: '（可疑推銷）' }), false);
  });

  it('keeps working in memory when the file cannot be written', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-names-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const names = createBotContactNames({ filePath: path.join(blocker, 'names.json') });
    names.record(null, '85261234567', '封鎖·惡意域名');
    assert.equal(names.wrote({ id: { _serialized: '85261234567@c.us' }, name: '封鎖·惡意域名' }), true);
  });

  it('tracks extraIds across record and forget', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-names-extra-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'bot-contact-names.json');
    const names = createBotContactNames({ filePath });
    const cUs = { id: { _serialized: '85261234567@c.us' }, name: '（可疑推銷）' };
    const lid = { id: { _serialized: '999@lid' }, name: '（可疑推銷）' };
    names.record(cUs, '85261234567', '（可疑推銷）', { extraIds: ['999@lid'] });
    assert.equal(names.wrote(cUs), true);
    assert.equal(names.wrote(lid), true);
    assert.equal(createBotContactNames({ filePath }).wrote(lid), true);
    names.forget(cUs, '85261234567', { extraIds: ['999@lid'] });
    assert.equal(names.wrote(cUs), false);
    assert.equal(names.wrote(lid), false);
  });

  it('backs up corrupt JSON and refuses to clobber on transient read errors', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-names-corrupt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const corruptFile = path.join(dir, 'bot-contact-names.json');
    fs.writeFileSync(corruptFile, '{bad');
    const recovered = createBotContactNames({ filePath: corruptFile });
    const entries = fs.readdirSync(dir);
    assert.ok(entries.some((f) => f.startsWith('bot-contact-names.json.corrupt.')));
    recovered.record(null, '85261234567', '（可疑推銷）');
    assert.equal(
      createBotContactNames({ filePath: corruptFile }).wrote({
        id: { _serialized: '85261234567@c.us' },
        name: '（可疑推銷）',
      }),
      true,
    );

    const eisdirTarget = path.join(dir, 'as-dir');
    fs.mkdirSync(eisdirTarget);
    const blocked = createBotContactNames({ filePath: eisdirTarget });
    assert.doesNotThrow(() => blocked.record(null, '85260001111', '封鎖·惡意域名'));
    assert.equal(
      blocked.wrote({ id: { _serialized: '85260001111@c.us' }, name: '封鎖·惡意域名' }),
      true,
    );
  });
});
