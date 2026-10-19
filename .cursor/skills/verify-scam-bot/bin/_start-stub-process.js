'use strict';

/**
 * Start stub-jevlike.js detached; print the node child pid on stdout (cross-platform).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = process.argv[2];
const port = process.argv[3];
const logPath = process.argv[4];

if (!root || !port || !logPath) {
  console.error('_start-stub-process: usage: <repo-root> <port> <log-path>');
  process.exit(1);
}

const script = path.join(root, 'stub-jevlike.js');
if (!fs.existsSync(script)) {
  console.error('_start-stub-process: missing stub-jevlike.js');
  process.exit(1);
}

const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [script], {
  cwd: root,
  env: { ...process.env, JEVLIKE_PORT: String(port) },
  detached: true,
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
child.unref();
fs.closeSync(logFd);

if (!child.pid) {
  console.error('_start-stub-process: failed to start stub');
  process.exit(1);
}
process.stdout.write(String(child.pid));
