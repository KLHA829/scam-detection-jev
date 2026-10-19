'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Resolve a real bash for skill bin scripts (avoid Win32 WSL `bash` stub). */
function resolveBash() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.env.VERIFY_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* ignore */
    }
  }
  const wh = spawnSync('where.exe', ['bash'], { encoding: 'utf8' });
  const lines = (wh.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/Git\\bin\\bash\.exe$/i.test(line) || /Git\\usr\\bin\\bash\.exe$/i.test(line)) {
      return line;
    }
  }
  return lines[0] || 'bash';
}

function spawnSkillScript(scriptName, opts = {}) {
  const script = path.join(__dirname, scriptName);
  const bash = resolveBash();
  if (bash) {
    return spawnSync(bash, [script], { encoding: 'utf8', ...opts });
  }
  return spawnSync(script, { encoding: 'utf8', ...opts });
}

module.exports = { resolveBash, spawnSkillScript };
