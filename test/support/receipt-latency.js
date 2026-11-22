'use strict';

const { performance } = require('node:perf_hooks');
const { handleWaMessage } = require('../../whatsapp-bot');
const { createActionPacer } = require('../../lib/action-pacer');

async function measureReceiptLatency(delayMs, { maskFails = true, archiveFails = false } = {}) {
  const events = [];
  const notices = [];
  const prompts = [];
  let maskPending = false;
  let bArchivedWhileMaskPending = false;
  let started;
  const maskStarted = new Promise((resolve) => { started = resolve; });
  let archiveLatency;
  let bStarted;
  const client = {
    info: { wid: { _serialized: 'self@c.us' } },
    async sendMessage(_wid, text) {
      const name = text.includes('左邊：Local A') ? 'A' : 'B';
      events.push(`${name}:receipt`);
      notices.push(text);
    },
  };
  const deps = {
    client,
    pacer: createActionPacer({ env: { WA_ACTION_GAP_MS: '0' } }),
    env: { CONTEXT_LLM_ENABLED: '0', LLM_REVIEW_COOLDOWN_MS: '0', BLOCK_ENABLED: 'false' },
    maskClient: {
      async maskMessages(messages) {
        if (messages[0].includes('chat A')) {
          maskPending = true;
          started();
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          maskPending = false;
          events.push('A:mask-resolved');
        }
        if (maskFails) throw new Error('mask unavailable');
        return { messages: messages.map(() => ({ spans: [] })) };
      },
    },
    llmReview: {
      apiUrl: 'http://llm.test/v1',
      async fetchImpl(_url, opts) {
        prompts.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ guide: '唔好撳連結，請用官方電話核實。' }) } }],
        }), { status: 200 });
      },
    },
  };
  function message(name, digits) {
    const id = `${digits}@c.us`;
    return {
      from: id,
      type: 'chat',
      body: `chat ${name} https://malicious-block-test.invalid/login`,
      getContact: async () => ({ id: { _serialized: id }, pushname: `Local ${name}`, isMyContact: false }),
      getChat: async () => ({
        id: { _serialized: id },
        async archive() {
          events.push(`${name}:archive`);
          if (name === 'B') {
            archiveLatency = performance.now() - bStarted;
            bArchivedWhileMaskPending = maskPending;
          }
          if (name === 'A' && archiveFails) throw new Error('archive unavailable');
        },
      }),
    };
  }
  const a = handleWaMessage(message('A', '85290001111'), deps);
  await maskStarted;
  bStarted = performance.now();
  const b = handleWaMessage(message('B', '85290002222'), deps);
  await Promise.all([a, b]);
  return { archiveLatency, bArchivedWhileMaskPending, events, notices, prompts };
}

module.exports = { measureReceiptLatency };
