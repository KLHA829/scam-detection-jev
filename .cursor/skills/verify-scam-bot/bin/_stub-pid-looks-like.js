'use strict';

/**
 * Cross-platform: exit 0 when pid's command line contains needle (default stub-jevlike.js).
 * Used by bash launch-stub / doctor / cleanup on Windows where /proc/pid/cmdline is absent.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

function cmdlineForPid(pid) {
  const procPath = `/proc/${pid}/cmdline`;
  if (fs.existsSync(procPath)) {
    try {
      return fs.readFileSync(procPath).toString('utf8').replace(/\0/g, ' ');
    } catch {
      return '';
    }
  }
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (ps.status === 0 && ps.stdout) return String(ps.stdout).trim();
    const wmic = spawnSync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/format:list'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (wmic.status === 0 && wmic.stdout) {
      const m = String(wmic.stdout).match(/^CommandLine=(.*)$/m);
      if (m) return m[1].trim();
    }
  }
  return '';
}

function pidLooksLikeStub(pid, needle = 'stub-jevlike.js') {
  if (!Number.isFinite(pid) || pid < 1) return false;
  const cmd = cmdlineForPid(pid);
  return cmd.includes(needle);
}

if (require.main === module) {
  const pid = Number(process.argv[2]);
  const needle = process.argv[3] || 'stub-jevlike.js';
  process.exit(pidLooksLikeStub(pid, needle) ? 0 : 1);
}

module.exports = { cmdlineForPid, pidLooksLikeStub };
