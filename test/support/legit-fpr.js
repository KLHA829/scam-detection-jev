'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../../lib/log');
const { processIncomingMessage } = require('../../lib/handle-incoming');
const { createRecentContext } = require('../../lib/context-llm');
const { createStubJevlikeClient } = require('../../stub-jevlike');
const { notScamLlmFetch } = require('../../lib/test-llm');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS_PATH = path.join(ROOT, 'fixtures', 'legit-messages.json');
const BASELINE_PATH = path.join(ROOT, 'fixtures', 'legit-fpr-baseline.json');
const MALICIOUS_HOSTS_PATH = path.join(ROOT, 'data', 'malicious-hosts.json');

function loadLegitMessages(file = CORPUS_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).messages;
}

function loadBaseline(file = BASELINE_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).falsePositives;
}

/**
 * Production defaults (context review on, automatic mode), with the model always answering
 * not_scam. Any archive or block therefore comes from the bot's own rules, not the model.
 */
async function runLegitMessage(message, { savedContact }) {
  const llmCalls = [];
  const notScam = notScamLlmFetch({ action: 'no_action' });
  const out = await processIncomingMessage(
    {
      type: 'chat',
      body: message.body,
      chatId: `${message.id}-${savedContact ? 'saved' : 'unsaved'}@c.us`,
      savedContact,
      isForwarded: message.forwarded === true,
    },
    {
      env: { LLM_REVIEW_COOLDOWN_MS: '0' },
      operatorMode: 'auto',
      maskClient: createStubJevlikeClient(),
      recentContext: createRecentContext(),
      llmReview: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (...args) => {
          llmCalls.push(args);
          return notScam(...args);
        },
      },
      resolveNumber: async () => ({ digits: '85261234567', unresolvedLid: false }),
      blockContact: async () => ({ renamed: true, blocked: true, muted: true, errors: [] }),
      archiveChat: async () => {},
      recordBlock: async () => {},
    },
  );
  return {
    action: out.decision.action,
    reason: out.decision.blockReason || out.decision.archiveReason || null,
    rule: out.heuristic && out.heuristic.hit ? out.heuristic.id : null,
    reachedLlm: llmCalls.length > 0,
  };
}

/** Each message runs once from an unsaved and once from a saved contact. */
async function runLegitBenchmark(messages = loadLegitMessages()) {
  const quiet = ['scan', 'info', 'ok', 'warn'];
  const saved = quiet.map((level) => log[level]);
  const hostsPath = process.env.MALICIOUS_HOSTS_PATH;
  for (const level of quiet) log[level] = () => {};
  // Measure the shipped host list, not a local override.
  process.env.MALICIOUS_HOSTS_PATH = MALICIOUS_HOSTS_PATH;
  try {
    const results = [];
    for (const message of messages) {
      for (const savedContact of [false, true]) {
        results.push({ message, savedContact, ...(await runLegitMessage(message, { savedContact })) });
      }
    }
    return results;
  } finally {
    quiet.forEach((level, i) => { log[level] = saved[i]; });
    if (hostsPath === undefined) delete process.env.MALICIOUS_HOSTS_PATH;
    else process.env.MALICIOUS_HOSTS_PATH = hostsPath;
  }
}

/** Stable, sorted list used by the baseline file and the test. */
function falsePositives(results) {
  return results
    .filter((r) => r.action !== 'ignore')
    .map((r) => ({
      id: r.message.id,
      contact: r.savedContact ? 'saved' : 'unsaved',
      action: r.action,
      rule: r.rule,
    }))
    .sort((a, b) => `${a.id}|${a.contact}`.localeCompare(`${b.id}|${b.contact}`));
}

function summarize(results) {
  const rate = (n, d) => `${n}/${d} (${d ? ((100 * n) / d).toFixed(1) : '0.0'}%)`;
  const rows = [];
  for (const contact of ['unsaved', 'saved']) {
    const runs = results.filter((r) => (r.savedContact ? 'saved' : 'unsaved') === contact);
    rows.push({
      contact,
      messages: runs.length,
      blocked: rate(runs.filter((r) => r.action === 'block').length, runs.length),
      archived: rate(runs.filter((r) => r.action !== 'ignore').length, runs.length),
      reachedLlm: rate(runs.filter((r) => r.reachedLlm).length, runs.length),
    });
  }
  return rows;
}

module.exports = {
  BASELINE_PATH,
  loadLegitMessages,
  loadBaseline,
  runLegitMessage,
  runLegitBenchmark,
  falsePositives,
  summarize,
};
