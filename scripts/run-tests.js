#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Cross-platform `npm test` launcher (JS test runner + Python unittest runner).
 * Replaces inline POSIX `LLM_REVIEW_COOLDOWN_MS=0 ...` so Windows PowerShell/cmd
 * and Linux/macOS run the exact same command.
 */

const { spawnSync } = require('child_process');

const UNSET_ENV = [
  'BLOCK_ENABLED',
  'HEURISTIC_ENABLED',
  'OPERATOR_MODE',
  'CONTEXT_LLM_ENABLED',
  'LLM_REVIEW_ENABLED',
  'MALICIOUS_HOSTS_PATH',
  'BOT_CONTACT_NAMES_PATH',
  'USER_RESTORED_CHATS_PATH',
  'WA_TRANSPORT',
  'WA_BRIDGE_URL',
  'WA_BRIDGE_TOKEN',
  'WA_BRIDGE_AUTO_START',
  'WA_BRIDGE_BIN',
  'WA_BRIDGE_TIMEOUT_MS',
  'WA_BRIDGE_DB_PATH',
  'WA_BRIDGE_CURSOR_PATH',
];

const env = { ...process.env, LLM_REVIEW_COOLDOWN_MS: '0' };
for (const key of UNSET_ENV) delete env[key];

const jsRun = spawnSync(
  process.execPath,
  ['--require', './scripts/block-log-test-setup.js', '--test'],
  { stdio: 'inherit', env }
);
if (jsRun.error) {
  console.error(`[ERROR] failed to run JS tests: ${jsRun.error.message}`);
  process.exit(1);
}
if (jsRun.status !== 0) {
  process.exit(jsRun.status === null ? 1 : jsRun.status);
}

const pyRun = spawnSync(process.execPath, ['scripts/run-py-tests.js'], {
  stdio: 'inherit',
  env,
});
if (pyRun.error) {
  console.error(`[ERROR] failed to run Python tests: ${pyRun.error.message}`);
  process.exit(1);
}

process.exit(pyRun.status === null ? 1 : pyRun.status);
