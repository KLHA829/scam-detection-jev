'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readRepo = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const files = [
  'whatsapp-bot.js',
  'jevlike_serve.py',
  'stub-jevlike.js',
  'scripts/download_jevlike_ckpt.sh',
  ...fs.readdirSync(__dirname)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => `lib/${name}`),
];

// Legacy scorer/eval controls, not live inbound settings.
const LAB_ONLY = new Set([
  'ARCHIVE_THRESHOLD', 'SAFE_THRESHOLD', 'BLOCK_THRESHOLD',
  'JEVLIKE_MAX_CHARS', 'CONTEXT_BENIGN_MIN_CHARS',
  'LLM_REVIEW_ON_HIGH', 'LLM_REVIEW_MERGE',
  'LLM_REVIEW_GREY_MIN', 'LLM_REVIEW_GREY_MAX', 'LLM_REVIEW_OTP_MAX_CHARS',
]);

function envReads(source) {
  const patterns = [
    /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g,
    /\b(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
    /os\.environ(?:\.get\(\s*|\[\s*)['"]([A-Z][A-Z0-9_]*)['"]/g,
    /(?:env_str|env_int|envFlag|envNumber|envInt)\(\s*(?:\w+\s*,\s*)?['"]([A-Z][A-Z0-9_]*)['"]/g,
    /\$\{([A-Z][A-Z0-9_]*):-/g,
  ];
  return [...new Set(patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1])))].sort();
}

it('finds direct, aliased, helper and shell environment reads', () => {
  assert.deepEqual(envReads(`
    process.env.DIRECT; env.ALIASED; env['BRACKET']; process.env["INDEXED"];
    os.environ.get("PYTHON"); os.environ['PYTHON_INDEXED'];
    envNumber(merged, 'HELPER', 1); env_str("WORKER", "fallback");
    envNumber(
      env, 'MULTILINE', 1);
    \${SHELL:-default}
  `), ['ALIASED', 'BRACKET', 'DIRECT', 'HELPER', 'INDEXED', 'MULTILINE',
    'PYTHON', 'PYTHON_INDEXED', 'SHELL', 'WORKER']);
  assert.deepEqual(envReads(''), []);
  assert.deepEqual(envReads('const NOT_AN_ENV = "UNRELATED";'), []);
});

const settings = [...new Set(files.flatMap((file) => envReads(readRepo(file))))]
  .filter((name) => !LAB_ONLY.has(name)).sort();

for (const file of ['.env.example', 'README.md']) {
  it(`${file} documents every runtime/setup environment setting`, () => {
    const source = readRepo(file);
    const missing = settings.filter((name) => {
      const entry = file === '.env.example'
        ? new RegExp(`^#?\\s*${name}=`, 'm')
        : new RegExp('^\\|[^\\n]*`' + name + '`[^\\n]*\\|\\s*$', 'm');
      return !entry.test(source);
    });
    assert.equal(missing.length, 0, `Missing from ${file}: ${missing.join(', ')}`);
  });
}
