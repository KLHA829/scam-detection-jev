'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJsonl(relPath) {
  const file = path.join(ROOT, relPath);
  assert.ok(fs.existsSync(file), `missing ${relPath}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean);
  return lines.map((line, i) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`${relPath}:${i + 1}: invalid JSON: ${err.message}`);
    }
    return obj;
  });
}

describe('eval fixtures (hk50 + data_v2 test)', () => {
  it('hk50 JSONL matches meta counts and schema', () => {
    const rows = readJsonl('evals/hk50/hk50_real_eval.jsonl');
    const meta = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'evals/hk50/hk50_real_eval.meta.json'), 'utf8'),
    );
    assert.equal(rows.length, meta.n);
    assert.equal(rows.length, 50);
    let scam = 0;
    for (const row of rows) {
      assert.ok(row.id, 'id required');
      assert.ok(String(row.text).trim(), 'text required');
      assert.ok(['scam', 'not_scam'].includes(row.label), `bad label ${row.label}`);
      if (row.label === 'scam') scam += 1;
    }
    assert.equal(scam, meta.scam);
    assert.equal(rows.length - scam, meta.not_scam);
  });

  it('data_v2 test JSONL has required fields', () => {
    const rows = readJsonl('evals/data_v2/test.jsonl');
    assert.equal(rows.length, 270);
    for (const row of rows) {
      assert.ok(row.id);
      assert.ok(String(row.text).trim());
      assert.ok(['scam', 'not_scam'].includes(row.label));
    }
    const stats = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'evals/data_v2/stats.json'), 'utf8'),
    );
    assert.equal(stats.v2.test.n, 270);
  });

  it('frozen r1 baseline report parses', () => {
    const baselinePath = path.join(ROOT, 'evals/baselines/r1-hk50-data_v2-test.json');
    assert.ok(fs.existsSync(baselinePath), 'run npm run eval:hk -- --write-baseline … locally');
    const report = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.equal(report.head, 'jevlike-hf-r1');
    assert.ok(report.thresholds && typeof report.thresholds.archive === 'number');
    assert.ok(Array.isArray(report.corpora) && report.corpora.length >= 2);
    for (const corp of report.corpora) {
      assert.ok(corp.archive_line);
      assert.ok(typeof corp.archive_line.fp === 'number');
      assert.ok(corp.block_line_score_only && corp.block_line_score_only.note);
    }
  });
});
