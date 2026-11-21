'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { scripts } = require('../package.json');

for (const [state, original] of [
  ['populated', '{"operator":"existing record"}\n'],
  ['empty', ''],
  ['missing', null],
]) {
  it(`blocking tests leave an inherited operator block log untouched (${state})`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-log-regression-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const operatorLog = path.join(dir, 'operator-blocks.jsonl');
    if (original !== null) fs.writeFileSync(operatorLog, original);
    const defaultLog = path.join(__dirname, '..', 'blocks.jsonl');
    const readDefaultLog = () => fs.existsSync(defaultLog) ? fs.readFileSync(defaultLog) : null;
    const defaultBefore = readDefaultLog();
    const command = scripts.test.split(' && ')[0]
      .replace('--test', '--test lib/agents-invariants.test.js lib/wa-handlers.test.js lib/operator-review.test.js');
    const env = { ...process.env, BLOCK_LOG_PATH: operatorLog };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, {
      cwd: path.join(__dirname, '..'),
      env,
      shell: true,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(operatorLog) ? fs.readFileSync(operatorLog, 'utf8') : null, original);
    assert.deepEqual(readDefaultLog(), defaultBefore);
  });
}
