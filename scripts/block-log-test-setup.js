'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scam-bot-test-blocks-'));
process.env.BLOCK_LOG_PATH = path.join(dir, 'blocks.jsonl');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
