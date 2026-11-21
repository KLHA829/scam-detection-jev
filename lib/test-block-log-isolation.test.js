'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

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
    const defaultLog = path.join(dir, 'blocks.jsonl');
    const env = { ...process.env, BLOCK_LOG_PATH: operatorLog, LLM_REVIEW_COOLDOWN_MS: '0' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--require', path.join(__dirname, '../scripts/block-log-test-setup.js'),
      '--test',
      path.join(__dirname, 'agents-invariants.test.js'),
      path.join(__dirname, 'wa-handlers.test.js'),
      path.join(__dirname, 'operator-review.test.js'),
    ], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(operatorLog) ? fs.readFileSync(operatorLog, 'utf8') : null, original);
    assert.equal(fs.existsSync(defaultLog), false);
  });
}
