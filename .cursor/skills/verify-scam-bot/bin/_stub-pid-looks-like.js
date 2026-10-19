'use strict';

/**
 * Cross-platform: exit 0 when pid's command line (or Win32 child tree) contains needle.
 * On win32, optional runDir: accept stub.pid match + GET /health stub-jevlike when cmdline is opaque.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');

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
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (ps.status === 0 && ps.stdout && String(ps.stdout).trim()) {
      return String(ps.stdout).trim();
    }
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

function win32TreeHasNeedle(rootPid, needle) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$needle = ${JSON.stringify(needle)}
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue(${rootPid})
$seen = @{}
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue()
  if ($seen.ContainsKey($p)) { continue }
  $seen[$p] = $true
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if ($proc -and $proc.CommandLine -and ($proc.CommandLine -like "*$needle*")) { exit 0 }
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object { $queue.Enqueue($_.ProcessId) }
}
exit 1
`;
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return ps.status === 0;
}

function fetchHealthJson(baseUrl, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const url = new URL('/health', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function win32RecordedStubOk(pid, runDir) {
  if (!runDir || !fs.existsSync(runDir)) return false;
  const pidfile = path.join(runDir, 'stub.pid');
  const baseFile = path.join(runDir, 'base-url');
  if (!fs.existsSync(pidfile) || !fs.existsSync(baseFile)) return false;
  const recorded = fs.readFileSync(pidfile, 'utf8').trim();
  if (recorded !== String(pid)) return false;
  const base = fs.readFileSync(baseFile, 'utf8').trim();
  if (!base) return false;
  const health = await fetchHealthJson(base);
  return Boolean(health && health.ok === true && health.model === 'stub-jevlike');
}

async function pidLooksLikeStub(pid, needle = 'stub-jevlike.js', runDir = '') {
  if (!Number.isFinite(pid) || pid < 1) return false;
  const cmd = cmdlineForPid(pid);
  if (cmd.includes(needle)) return true;
  if (process.platform !== 'win32') return false;
  if (win32TreeHasNeedle(pid, needle)) return true;
  if (runDir && (await win32RecordedStubOk(pid, runDir))) return true;
  return false;
}

if (require.main === module) {
  const pid = Number(process.argv[2]);
  const needle = process.argv[3] || 'stub-jevlike.js';
  const runDir = process.argv[4] || process.env.STUB_RUN_DIR || '';
  pidLooksLikeStub(pid, needle, runDir)
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
}

module.exports = { cmdlineForPid, pidLooksLikeStub, win32TreeHasNeedle };
