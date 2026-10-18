'use strict';

/**
 * CI locks for agent-trust waves 1–2: stale docs, copy-traps, import boundaries.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('agent-trust — README must not regress to score-primary docs', () => {
  const readme = readRepo('README.md');

  const banned = [
    { label: 'LLM_REVIEW_ENABLED default false', re: /LLM_REVIEW_ENABLED[`\s].*default [`']false[`']/i },
    { label: 'scorer-only deploy', re: /scorer-only deploy/i },
    {
      label: 'live client posts to /v1/score',
      re: /Client posts.*\/v1\/score|posts `\{text\}` to `\{base\}\/v1\/score`/i,
    },
    { label: 'LLM 覆核預設關閉', re: /LLM 覆核預設關閉/ },
  ];

  for (const { label, re } of banned) {
    it(`README must not contain: ${label}`, () => {
      assert.equal(
        re.test(readme),
        false,
        `README.md still matches retired phrase (${label}). See AGENTS.md and .env.example.`,
      );
    });
  }
});

describe('agent-trust — live inbound copy-traps', () => {
  const inboundFiles = ['lib/handle-incoming.js', 'whatsapp-bot.js'];

  for (const rel of inboundFiles) {
    it(`${rel} must not reference scoreClient`, () => {
      const src = readRepo(rel);
      assert.equal(/\bscoreClient\b/.test(src), false, `${rel} still contains scoreClient`);
    });
  }

  it('handle-incoming must not import lab scoreMessage', () => {
    const src = readRepo('lib/handle-incoming.js');
    assert.equal(/\bscoreMessage\b/.test(src), false);
    assert.match(src, /require\('\.\/score-message'\)/);
    assert.doesNotMatch(src, /lab\/score-message/);
  });
});

describe('agent-trust — corpus stays offline', () => {
  const roots = ['whatsapp-bot.js', 'lib'];

  for (const rel of roots) {
    it(`${rel} must not import data/corpus`, () => {
      if (rel.endsWith('.js')) {
        assert.doesNotMatch(readRepo(rel), /data\/corpus/);
        return;
      }
      const dir = path.join(ROOT, rel);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js') || name === 'agent-trust.test.js') continue;
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile()) continue;
        assert.doesNotMatch(
          fs.readFileSync(file, 'utf8'),
          /data\/corpus/,
          `${rel}/${name} imports data/corpus`,
        );
      }
    });
  }
});

describe('agent-trust — live path masks before LLM review', () => {
  const src = readRepo('lib/handle-incoming.js');

  it('handle-incoming primary LLM path masks before reviewRedactedMessage', () => {
    const fnStart = src.indexOf('async function runIncomingMessage');
    assert.notEqual(fnStart, -1);
    const body = src.slice(fnStart);
    const maskIdx = body.indexOf('maskClient.maskMessages');
    const reviewIdx = body.indexOf('reviewRedactedMessage(redacted');
    assert.notEqual(maskIdx, -1);
    assert.notEqual(reviewIdx, -1);
    assert.ok(maskIdx < reviewIdx, 'mask must run before reviewRedactedMessage in runIncomingMessage');
  });

  it('context-llm reviewOpeningMessages masks before chat API', () => {
    const ctx = readRepo('lib/context-llm.js');
    const fnStart = ctx.indexOf('async function reviewOpeningMessages');
    const body = ctx.slice(fnStart);
    const maskIdx = body.indexOf('maskClient.maskMessages');
    const reviewIdx = body.indexOf('reviewMaskedTranscript');
    assert.ok(maskIdx !== -1 && reviewIdx !== -1 && maskIdx < reviewIdx);
  });

  it('handle-incoming must not import lab scoreMessage', () => {
    assert.doesNotMatch(src, /lab\/score-message/);
    assert.doesNotMatch(src, /\bscoreMessage\s*\(/);
  });

  it('whatsapp-bot.js must not import lab scoreMessage', () => {
    const bot = readRepo('whatsapp-bot.js');
    assert.doesNotMatch(bot, /lab\/score-message/);
    assert.doesNotMatch(bot, /\bscoreMessage\b/);
  });
});

describe('agent-trust — verify-scam-bot skill must not teach score-primary smoke', () => {
  const skill = readRepo('.cursor/skills/verify-scam-bot/SKILL.md');
  const features = readRepo('.cursor/skills/verify-scam-bot/features/README.md');

  it('SKILL.md primary drive is mask-before-llm', () => {
    assert.match(skill, /drive-mask-before-llm/);
    assert.doesNotMatch(skill, /scripted smoke feature is score archive/i);
  });

  it('features README labels lab score separately from live smoke', () => {
    assert.match(features, /lab-only|Lab jevlike score/i);
    assert.match(features, /Mask before LLM.*primary smoke/i);
  });

  it('drive-score-archive driver documents lab-only and createMaskClient test name', () => {
    const drv = readRepo('.cursor/skills/verify-scam-bot/bin/drive-score-archive');
    assert.match(drv, /lab-only|Lab-only/i);
    assert.doesNotMatch(drv, /createScoreClient/);
    assert.match(drv, /createMaskClient always builds a JevlikeClient/);
  });
});

describe('agent-trust — production must not require offline mask stub', () => {
  const liveModules = [
    'lib/handle-incoming.js',
    'lib/llm-review.js',
    'lib/context-llm.js',
    'whatsapp-bot.js',
  ];

  for (const rel of liveModules) {
    it(`${rel} must not require mask-spans stub`, () => {
      const src = readRepo(rel);
      assert.doesNotMatch(src, /mask-spans/);
      assert.doesNotMatch(src, /mask-spans-stub/);
    });
  }
});
