'use strict';

/**
 * CI locks for agent-trust waves 1–2: stale docs, copy-traps, import boundaries.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('agent-trust — README must not regress to score-primary docs', () => {
  const readme = readRepo('README.md');

  it('README worker guides download the PII mask head and check health', () => {
    const workerGuide = readme.split('## Run the worker and the bot')[1].split('### Windows notes')[0];
    const guides = workerGuide.split('### Raspberry Pi (正體中文)');
    assert.equal(guides.length, 2);
    for (const guide of guides) {
      assert.match(guide, /scripts\/download_pii_mask_ckpt\.sh/);
      assert.match(guide, /curl[^\n]*\/health/);
      assert.match(guide, /"pii_mask":\s*true/);
    }
  });

  it('PII mask downloader pins the documented hn2 asset and hash', () => {
    const downloader = readRepo('scripts/download_pii_mask_ckpt.sh');
    const modelsReadme = readRepo('models/README.md');
    for (const text of [downloader, modelsReadme]) {
      assert.match(text, /jevlike-pii-mask-hn2/);
      assert.match(text, /jevlike_hf_pii_mask_hn2\.pt/);
      assert.match(text, /55a52625d328f58e5aa227039b31f83308f8a5e2b233ca61ad7de614a8a9a5fa/);
    }
  });

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

describe('agent-trust — curated-host docs require mask before LLM', () => {
  const docs = ['README.md', 'DESIGN_DECISIONS.md', 'SCORING_RUBRIC.md', '.env.example'];
  const retired = [
    {
      label: 'curated URL or email match recommends archive without AI',
      re: /curated URL or email-domain match can still recommend archive without AI/i,
    },
    {
      label: 'curated blocklist archives without the LLM',
      re: /curated blocklist matches can still archive without the LLM/i,
    },
    { label: 'curated blocklist fast path', re: /curated blocklist fast path/i },
    {
      label: 'curated match bypasses AI',
      re: /only a curated URL or email-domain match[^\n]*bypasses AI/i,
    },
    {
      label: 'warning-only exception directly archives',
      re: /outside the warning-only exception directly archives/i,
    },
    { label: 'hard link archives skip LLM', re: /hard link archives skip LLM/i },
    { label: 'heuristic-only archives', re: /leaves only heuristic archives/i },
    {
      label: 'link rules avoid LLM latency for archive or block',
      re: /slow model does not delay archive or malicious-host block/i,
    },
  ];

  it('operator docs do not revive a curated no-LLM archive path', () => {
    for (const rel of docs) {
      const text = readRepo(rel);
      for (const { label, re } of retired) {
        assert.doesNotMatch(text, re, `${rel} still documents ${label}`);
      }
    }
  });

  it('operator docs state that curated matches still use mask then LLM', () => {
    assert.match(readRepo('README.md'), /Curated URL and email-domain matches also go through mask\s*→\s*LLM/);
    assert.match(readRepo('DESIGN_DECISIONS.md'), /Curated URL and email-domain matches[^\n]*do not bypass AI/);
    assert.match(readRepo('.env.example'), /Matches still require mask -> LLM confirmation/);
  });
});

describe('agent-trust — live inbound copy-traps', () => {
  const inboundFiles = ['lib/handle-incoming.js', 'whatsapp-bot.js'];

  for (const rel of inboundFiles) {
    it(`${rel} must not reference scoreClient`, () => {
      const src = readRepo(rel);
      assert.equal(/\bscoreClient\b/.test(src), false, `${rel} still contains scoreClient`);
    });

    it(`${rel} must not load the lab scoring rubric`, () => {
      const src = readRepo(rel);
      assert.doesNotMatch(src, /score-message'\)/);
      assert.doesNotMatch(src, /\b(loadRubric|RUBRIC_PATH)\b/);
    });
  }

  it('handle-incoming must not import lab scoreMessage', () => {
    const src = readRepo('lib/handle-incoming.js');
    assert.equal(/\bscoreMessage\b/.test(src), false);
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

const VERIFY_SKILL_ROOTS = [
  '.cursor/skills/verify-scam-bot',
  '.cursor/skills/verify-scam-detection-jev',
];

const SCORE_PRIMARY_BANNED = [
  { label: 'scripted smoke feature is score archive', re: /scripted smoke feature is score archive/i },
  { label: 'createScoreClient test name in drivers', re: /createScoreClient/ },
  {
    label: 'live score smoke without lab qualifier',
    re: /primary smoke.*(?:score-archive|POST \/v1\/score)/i,
  },
];

function listSkillFiles(skillRoot) {
  const out = [];
  const skillMd = path.join(ROOT, skillRoot, 'SKILL.md');
  if (fs.existsSync(skillMd)) out.push(`${skillRoot}/SKILL.md`);
  const featuresDir = path.join(ROOT, skillRoot, 'features');
  if (fs.existsSync(featuresDir)) {
    for (const name of fs.readdirSync(featuresDir)) {
      if (name.endsWith('.md')) out.push(`${skillRoot}/features/${name}`);
    }
  }
  const binDir = path.join(ROOT, skillRoot, 'bin');
  if (fs.existsSync(binDir)) {
    for (const name of fs.readdirSync(binDir)) {
      if (name === '_canonical') continue;
      const file = path.join(binDir, name);
      if (fs.statSync(file).isFile()) out.push(`${skillRoot}/bin/${name}`);
    }
  }
  return out;
}

describe('agent-trust — verification skills must not teach score-primary smoke', () => {
  const canonicalSkill = readRepo('.cursor/skills/verify-scam-bot/SKILL.md');
  const canonicalFeatures = readRepo('.cursor/skills/verify-scam-bot/features/README.md');
  const aliasSkill = readRepo('.cursor/skills/verify-scam-detection-jev/SKILL.md');

  it('verify-scam-bot primary drive is mask-before-llm', () => {
    assert.match(canonicalSkill, /drive-mask-before-llm/);
    assert.doesNotMatch(canonicalSkill, /scripted smoke feature is score archive/i);
  });

  it('verify-scam-bot features README labels lab score separately from live smoke', () => {
    assert.match(canonicalFeatures, /lab-only|Lab jevlike score/i);
    assert.match(canonicalFeatures, /Mask before LLM.*primary smoke/i);
  });

  it('verify-scam-detection-jev SKILL redirects to verify-scam-bot', () => {
    assert.match(aliasSkill, /verify-scam-bot/);
    assert.match(aliasSkill, /Canonical verification skill/i);
    assert.doesNotMatch(aliasSkill, /scripted smoke feature is score archive/i);
  });

  it('verify-scam-detection-jev bin shims point at verify-scam-bot', () => {
    const shim = readRepo('.cursor/skills/verify-scam-detection-jev/bin/_canonical');
    assert.match(shim, /verify-scam-bot\/bin/);
    const prove = readRepo('.cursor/skills/verify-scam-detection-jev/bin/prove-malicious-host-block');
    assert.match(prove, /VERIFY_SCAM_BOT_BIN/);
    assert.match(prove, /drive-malicious-host-block/);
  });

  it('verify-scam-detection-jev must not retain legacy artifacts/', () => {
    const legacy = path.join(ROOT, '.cursor/skills/verify-scam-detection-jev/artifacts');
    assert.equal(fs.existsSync(legacy), false);
  });

  it('verify-scam-detection-jev features/ is a single redirect README', () => {
    const dir = path.join(ROOT, '.cursor/skills/verify-scam-detection-jev/features');
    const md = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
    assert.deepEqual(md, ['README.md']);
  });

  for (const skillRoot of VERIFY_SKILL_ROOTS) {
    for (const rel of listSkillFiles(skillRoot)) {
      if (rel.includes('/artifacts/') || rel.includes('/evidence/')) continue;
      const base = path.basename(rel);
      if (base === 'drive-score-archive') continue;
      it(`${rel} must not contain score-primary drift phrases`, () => {
        const text = readRepo(rel);
        for (const { label, re } of SCORE_PRIMARY_BANNED) {
          assert.equal(
            re.test(text),
            false,
            `${rel} matches banned phrase: ${label}`,
          );
        }
      });
    }
  }

  it('drive-score-archive driver documents lab-only and createMaskClient test name', () => {
    const drv = readRepo('.cursor/skills/verify-scam-bot/bin/drive-score-archive');
    assert.match(drv, /lab-only|Lab-only/i);
    assert.doesNotMatch(drv, /createScoreClient/);
    assert.match(drv, /createMaskClient always builds a JevlikeClient/);
  });
});

describe('agent-trust — secrets and config surface (read-only)', () => {
  it('.env is listed in .gitignore', () => {
    const gi = readRepo('.gitignore');
    assert.match(gi, /^\.env$/m);
  });

  it('git must not track a root .env file', () => {
    const tracked = execSync('git ls-files -- .env', {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim();
    assert.equal(tracked, '');
  });

  it('.env.example must not ship placeholder API secrets', () => {
    const example = readRepo('.env.example');
    assert.doesNotMatch(example, /sk-[a-zA-Z0-9]{20,}/);
    assert.doesNotMatch(example, /OPENAI_API_KEY=\S+/);
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
