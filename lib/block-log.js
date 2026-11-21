// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

function defaultBlockLogPath(env = process.env) {
  if (env && env.BLOCK_LOG_PATH) return env.BLOCK_LOG_PATH;
  return path.join(process.cwd(), 'blocks.jsonl');
}

function appendBlockRecord(record, filePath = defaultBlockLogPath()) {
  const line = `${JSON.stringify(record)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, 'utf8');
  return filePath;
}

function readRecentBlockRecords(limit = 20, filePath = defaultBlockLogPath()) {
  const max = Math.max(1, Number(limit) || 20);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt lines
    }
  }
  return rows.slice(-max);
}

module.exports = {
  defaultBlockLogPath,
  appendBlockRecord,
  readRecentBlockRecords,
};
