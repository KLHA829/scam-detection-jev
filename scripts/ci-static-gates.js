#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Fast CI checks: verify-skill doc drift, CONTEXT_LLM default consistency, alias redirect.
 * Complements lib/agent-trust.test.js (npm test) with a cheap gate that needs no npm ci.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function fail(message) {
  console.error(`ci-static-gates: ${message}`);
  failures += 1;
}

function pass(message) {
  console.log(`ok: ${message}`);
}

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listMdUnder(dirRel) {
  const dir = path.join(ROOT, dirRel);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => `${dirRel}/${n}`);
}

const SCORE_PRIMARY_BANNED = [
  { label: 'scripted smoke feature is score archive', re: /scripted smoke feature is score archive/i },
  { label: 'createScoreClient in drivers', re: /createScoreClient/ },
  {
    label: 'live score smoke without lab qualifier',
    re: /primary smoke.*(?:score-archive|POST \/v1\/score)/i,
  },
];

const VERIFY_SKILL = '.cursor/skills/verify-scam-bot';
const VERIFY_ALIAS = '.cursor/skills/verify-scam-detection-jev';

function gateScorePrimaryDocs() {
  const files = [
    `${VERIFY_SKILL}/SKILL.md`,
    ...listMdUnder(`${VERIFY_SKILL}/features`),
  ].filter((rel) => {
    const base = path.basename(rel);
    return base !== 'lab-jevlike-score.md' && base !== 'score-archive.md';
  });

  for (const rel of files) {
    const text = readRepo(rel);
    for (const { label, re } of SCORE_PRIMARY_BANNED) {
      if (re.test(text)) {
        fail(`${rel} matches banned score-primary phrase: ${label}`);
      }
    }
  }
  const labDriver = `${VERIFY_SKILL}/bin/drive-score-archive`;
  if (fs.existsSync(path.join(ROOT, labDriver))) {
    const drv = readRepo(labDriver);
    if (/createScoreClient/.test(drv)) {
      fail(`${labDriver} must not reference createScoreClient`);
    }
    if (!/lab-only|Lab-only/i.test(drv)) {
      fail(`${labDriver} must document lab-only usage`);
    }
  }
  pass('verify-scam-bot docs/drivers do not teach score-primary live smoke');
}

const CONTEXT_LLM_DEFAULT_OFF = [
  /CONTEXT_LLM_ENABLED[^.\n]{0,80}default\s+off/i,
  /default\s+off[^.\n]{0,80}CONTEXT_LLM_ENABLED/i,
];

function gateContextLlmDefault() {
  const ctx = readRepo('lib/context-llm.js');
  if (!/envFlag\(env,\s*'CONTEXT_LLM_ENABLED',\s*true\)/.test(ctx)) {
    fail('lib/context-llm.js must default CONTEXT_LLM_ENABLED to true via envFlag(..., true)');
  } else {
    pass('lib/context-llm.js defaults CONTEXT_LLM_ENABLED on');
  }

  const docFiles = [
    `${VERIFY_SKILL}/SKILL.md`,
    ...listMdUnder(`${VERIFY_SKILL}/features`),
  ];
  for (const rel of docFiles) {
    const text = readRepo(rel);
    for (const re of CONTEXT_LLM_DEFAULT_OFF) {
      if (re.test(text)) {
        fail(`${rel} claims CONTEXT_LLM_ENABLED defaults off; code defaults on (AGENTS.md)`);
      }
    }
  }
  pass('verify-scam-bot feature docs agree CONTEXT_LLM_ENABLED defaults on');
}

function gateVerifyAliasRedirect() {
  const aliasSkill = readRepo(`${VERIFY_ALIAS}/SKILL.md`);
  if (!/verify-scam-bot/.test(aliasSkill) || !/Canonical verification skill/i.test(aliasSkill)) {
    fail(`${VERIFY_ALIAS}/SKILL.md must redirect to verify-scam-bot`);
  }
  const shim = readRepo(`${VERIFY_ALIAS}/bin/_canonical`);
  if (!/verify-scam-bot\/bin/.test(shim)) {
    fail(`${VERIFY_ALIAS}/bin/_canonical must point at verify-scam-bot/bin`);
  }
  const legacyArtifacts = path.join(ROOT, VERIFY_ALIAS, 'artifacts');
  if (fs.existsSync(legacyArtifacts)) {
    fail(`${VERIFY_ALIAS}/artifacts must not exist (legacy duplicate harness)`);
  }
  const featDir = path.join(ROOT, VERIFY_ALIAS, 'features');
  const md = fs.readdirSync(featDir).filter((n) => n.endsWith('.md')).sort();
  if (md.join(',') !== 'README.md') {
    fail(`${VERIFY_ALIAS}/features must only contain README.md redirect`);
  }
  pass('verify-scam-detection-jev alias still redirects to verify-scam-bot');
}

gateScorePrimaryDocs();
gateContextLlmDefault();
gateVerifyAliasRedirect();

if (failures > 0) {
  console.error(`ci-static-gates: ${failures} gate(s) failed`);
  process.exit(1);
}
console.log('ci-static-gates: all gates passed');
