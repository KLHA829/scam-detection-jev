#!/usr/bin/env node
'use strict';

/**
 * Portable Python-3 launcher for the `npm test` unittest half.
 *
 * `npm test` used to hard-code `python3`. On Windows there is no `python3` on
 * PATH, and a Windows venv ships only `python.exe` — so the JS half ran, then the
 * Python half died with "python3: command not found" (npm exit 49) even with the
 * venv active.
 *
 * Interpreter selection cannot be a PATH check: the Microsoft Store ships a
 * `python.exe` app-execution-alias stub that spawns successfully but exits
 * non-zero, so the candidate has to be probed with a real `-c` invocation.
 */

const { spawnSync } = require('child_process');

const CANDIDATES =
  process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

const PROBE = 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)';

function usable(bin) {
  const probe = spawnSync(bin, ['-c', PROBE], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

const python = CANDIDATES.find(usable);

if (!python) {
  console.error(
    `[ERROR] no Python 3 interpreter found (tried: ${CANDIDATES.join(', ')}).\n` +
      '        Install Python 3.11+ on PATH, or activate the .venv first.'
  );
  process.exit(1);
}

const run = spawnSync(python, ['-m', 'unittest', 'test_jevlike_serve.py'], {
  stdio: 'inherit',
});

if (run.error) {
  console.error(`[ERROR] failed to run ${python}: ${run.error.message}`);
  process.exit(1);
}

process.exit(run.status === null ? 1 : run.status);
