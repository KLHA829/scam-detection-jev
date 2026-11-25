#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Build the pure-Go wa-bridge sidecar binary (`CGO_ENABLED=0`).
 * Supports `--goos <os>`, `--goarch <arch>`, and `--out <path>` (with env
 * fallbacks `GOOS` / `GOARCH` / `WA_BRIDGE_BIN`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BRIDGE_DIR = path.join(ROOT, 'wa-bridge');

function parseArgs(argv) {
  /** @type {{ goos?: string, goarch?: string, out?: string }} */
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--goos' && i + 1 < argv.length) {
      parsed.goos = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--goos=')) {
      parsed.goos = arg.slice('--goos='.length);
    } else if (arg === '--goarch' && i + 1 < argv.length) {
      parsed.goarch = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--goarch=')) {
      parsed.goarch = arg.slice('--goarch='.length);
    } else if (arg === '--out' && i + 1 < argv.length) {
      parsed.out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      parsed.out = arg.slice('--out='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function hostGoos(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform;
}

function hostGoarch(arch = process.arch) {
  if (arch === 'x64') return 'amd64';
  if (arch === 'ia32') return '386';
  return arch;
}

function defaultBinaryName(
  goos = '',
  goarch = '',
  { hostOs = hostGoos(), hostArch = hostGoarch() } = {},
) {
  const targetOs = String(goos || hostOs).trim();
  const targetArch = String(goarch || hostArch).trim();
  const ext = targetOs === 'windows' ? '.exe' : '';
  if (targetOs === hostOs && targetArch === hostArch) {
    return `wa-bridge${ext}`;
  }
  return `wa-bridge-${targetOs}-${targetArch}${ext}`;
}

/**
 * Resolve the output path for `wa-bridge` without letting cross-builds clobber
 * the default native host binary unless `--out` or `WA_BRIDGE_BIN` is set.
 * @param {{ goos?: string, goarch?: string, outPath?: string, cwd?: string, hostOs?: string, hostArch?: string }} [options]
 */
function resolveTargetPath(options = {}) {
  const rawOut = options.outPath ? String(options.outPath).trim() : '';
  if (rawOut) {
    return path.resolve(options.cwd || process.cwd(), rawOut);
  }
  return path.join(
    BRIDGE_DIR,
    defaultBinaryName(options.goos, options.goarch, {
      hostOs: options.hostOs,
      hostArch: options.hostArch,
    }),
  );
}

/**
 * Compile `wa-bridge/` into `outPath` (defaults to `wa-bridge/wa-bridge[.exe]`
 * for native builds, or `wa-bridge/wa-bridge-<goos>-<goarch>[.exe]` for cross-builds).
 * @param {{ goos?: string, goarch?: string, outPath?: string, cwd?: string, quiet?: boolean }} [options]
 */
function buildWaBridge(options = {}) {
  const goos = String(options.goos ?? process.env.GOOS ?? '').trim();
  const goarch = String(options.goarch ?? process.env.GOARCH ?? '').trim();
  const targetPath = resolveTargetPath({
    goos,
    goarch,
    outPath: options.outPath,
    cwd: options.cwd,
  });

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, CGO_ENABLED: '0' };
  if (goos) env.GOOS = goos;
  if (goarch) env.GOARCH = goarch;

  const res = spawnSync(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', targetPath, '.'],
    {
      cwd: BRIDGE_DIR,
      env,
      stdio: options.quiet ? 'pipe' : 'inherit',
      encoding: 'utf8',
    },
  );
  if (res.error) {
    const hint =
      /** @type {NodeJS.ErrnoException} */ (res.error).code === 'ENOENT'
        ? 'Go toolchain (`go`) was not found on PATH. Install Go 1.26+ to build wa-bridge.'
        : res.error.message;
    throw new Error(`Failed to run go build: ${hint}`);
  }
  if (res.status !== 0) {
    const detail = res.stderr ? `\n${String(res.stderr).trim()}` : '';
    throw new Error(`go build failed with exit code ${res.status}${detail}`);
  }
  return targetPath;
}

if (require.main === module) {
  try {
    const cli = parseArgs(process.argv.slice(2));
    const configuredOut = cli.out || process.env.WA_BRIDGE_BIN || undefined;
    const built = buildWaBridge({
      goos: cli.goos,
      goarch: cli.goarch,
      outPath: configuredOut,
    });
    process.stdout.write(`Built wa-bridge: ${built}\n`);
  } catch (err) {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildWaBridge,
  defaultBinaryName,
  hostGoarch,
  hostGoos,
  parseArgs,
  resolveTargetPath,
};
