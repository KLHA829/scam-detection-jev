// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function renameWithRetry(tmpPath, filePath, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (!err || !RETRY_CODES.has(err.code) || attempt >= maxAttempts) {
        throw err;
      }
      sleepSync(15 * attempt);
    }
  }
}

function backupCorruptFile(filePath) {
  const backup = `${filePath}.corrupt.${Date.now()}`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(filePath, backup);
  } catch {}
}

/**
 * Read a JSON state file while distinguishing missing files (`ENOENT`) from
 * corrupt JSON (`SyntaxError`) or transient I/O failures (`EBUSY`/`EPERM`).
 */
function readJsonFile(filePath) {
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, exists: false, corrupt: false, transient: false, data: null, error: null };
    }
    log.error('failed to read json file', {
      path: filePath,
      code: err && err.code,
      error: err && err.message ? err.message : String(err),
    });
    return { ok: false, exists: true, corrupt: false, transient: true, data: null, error: err };
  }
  try {
    return {
      ok: true,
      exists: true,
      corrupt: false,
      transient: false,
      data: JSON.parse(rawText),
      error: null,
    };
  } catch (err) {
    log.error('corrupt json file', {
      path: filePath,
      error: err && err.message ? err.message : String(err),
    });
    backupCorruptFile(filePath);
    return { ok: false, exists: true, corrupt: true, transient: false, data: null, error: err };
  }
}

/**
 * Atomically write JSON via a per-PID `.tmp` file with bounded Windows
 * `EPERM`/`EBUSY`/`EACCES` rename retries and cleanup on failure.
 */
function writeJsonFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  let wroteTmp = false;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    wroteTmp = true;
    renameWithRetry(tmp, filePath);
  } catch (err) {
    if (wroteTmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    throw err;
  }
}

module.exports = {
  readJsonFile,
  writeJsonFileAtomic,
};
