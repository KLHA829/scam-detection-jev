#!/usr/bin/env node
'use strict';

/**
 * Run scripts/eval_jevlike.py with a usable Python 3 (prefer .venv/bin/python).
 * See evals/README.md and `npm run eval:hk`.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENV_PY =
  process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');

const CANDIDATES = [];
if (fs.existsSync(VENV_PY)) CANDIDATES.push(VENV_PY);
CANDIDATES.push(process.platform === 'win32' ? 'python' : 'python3', 'python');

const PROBE = 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)';

function usable(bin) {
  const probe = spawnSync(bin, ['-c', PROBE], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

const python = CANDIDATES.find(usable);
if (!python) {
  console.error(
    `[ERROR] no Python 3 found (tried: ${CANDIDATES.join(', ')}).\n` +
      '        python3 -m venv .venv && pip install -r requirements.txt',
  );
  process.exit(1);
}

const script = path.join(__dirname, 'eval_jevlike.py');
const extra = process.argv.slice(2);
const run = spawnSync(python, [script, ...extra], { cwd: ROOT, stdio: 'inherit' });

if (run.error) {
  console.error(`[ERROR] failed to run ${python}: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status === null ? 1 : run.status);
