'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { handleWaMessage } = require('../../whatsapp-bot');
const { createActionPacer } = require('../../lib/action-pacer');
const { createReviewQueue } = require('../../lib/review-queue');

async function measureGuidedLatency(delayMs, { stage = 'mask', fails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-latency-'));
  const events = [];
  let pending = false;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let archiveLatency;
  let archivedWhilePending;
  let bStarted;
  const start = performance.now();
  async function slow() {
    pending = true;
    started();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    pending = false;
    if (fails) throw new Error('explanation unavailable');
  }
  const deps = {
    client: {
      info: { wid: { _serialized: 'self@c.us' } },
      async sendMessage(_wid, text) {
        events.push(typeof text === 'string' ? 'text' : 'poll');
        return { id: { _serialized: `out-${events.length}` } };
      },
    },
    pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    env: { CONTEXT_LLM_ENABLED: '0', LLM_REVIEW_COOLDOWN_MS: '0' },
    operator: { mode: () => 'guided', awaitingChoice: () => false },
    reviewQueue: createReviewQueue({ filePath: path.join(dir, 'queue.json') }),
    maskClient: {
      async maskMessages(messages) {
        if (stage === 'mask') await slow();
        return { messages: messages.map(() => ({ spans: [] })) };
      },
    },
    llmReview: {
      apiUrl: 'http://llm.test/v1',
      async fetchImpl() {
        if (stage === 'llm') await slow();
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ guide: '請用官方電話核實。' }) } }],
        }), { status: 200 });
      },
    },
  };
  function message(name, digits) {
    const id = `${digits}@c.us`;
    return {
      id: { _serialized: `message-${name}` }, from: id, type: 'chat',
      body: 'https://hsbc.evil.com',
      async forward() { events.push('forward'); },
      getContact: async () => ({ id: { _serialized: id }, pushname: name }),
      getChat: async () => ({
        id: { _serialized: id },
        async archive() {
          events.push(`${name}:archive`);
          archiveLatency = performance.now() - bStarted;
          archivedWhilePending = pending;
        },
      }),
    };
  }
  try {
    const a = handleWaMessage(message('A', '85290001111'), deps);
    await ready;
    bStarted = performance.now();
    const b = handleWaMessage(message('B', '85290002222'), {
      ...deps, operator: null, maskClient: null,
    });
    await Promise.all([a, b]);
    const totalMs = performance.now() - start;
    return { archiveLatency, archivedWhilePending, events, totalMs, throughput: 2000 / totalMs };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { measureGuidedLatency };
