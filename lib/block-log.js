'use strict';

const fs = require('fs');
const path = require('path');

function defaultBlockLogPath(env = process.env) {
  if (env && env.BLOCK_LOG_PATH) return env.BLOCK_LOG_PATH;
  return path.join(process.cwd(), 'blocks.jsonl');
}

function appendBlockRecord(record, filePath = defaultBlockLogPath()) {
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(filePath, line, 'utf8');
  return filePath;
}

module.exports = {
  defaultBlockLogPath,
  appendBlockRecord,
};
