'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startStubServer } = require('../stub-jevlike');

const ROOT = path.join(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('local test server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function userPrompt(body) {
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => message && message.role === 'user')
    .map((message) => String(message.content || ''))
    .join('\n');
}

function systemPrompt(body) {
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => message && message.role === 'system')
    .map((message) => String(message.content || ''))
    .join('\n');
}

function isContextRequest(body) {
  return systemPrompt(body).includes('You review the latest inbound WhatsApp messages');
}

function createMockServer(requests, currentScenario) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    try {
      const body = await readJson(req);
      requests.push({
        scenario: currentScenario(),
        body,
      });

      const usr = userPrompt(body);
      const sys = systemPrompt(body);
      const curatedMalicious = /confirmed malicious-host list/i.test(sys);
      const antiScamWarning = /防騙|假網站|切勿|唔好撳|do not visit/i.test(usr);
      const listedLure = curatedMalicious && !antiScamWarning;
      const investment = /投資|investment/i.test(usr);
      const bankImpersonation = /銀行職員/.test(usr);
      const content = isContextRequest(body)
        ? JSON.stringify({
            action: listedLure || investment || bankImpersonation ? 'archive' : 'no_action',
            strong: listedLure || bankImpersonation,
            confidence: 0.9,
            reason: listedLure
              ? 'mock_listed_lure'
              : bankImpersonation
                ? 'mock_bank_impersonation'
                : investment
                  ? 'mock_investment'
                  : 'mock_benign',
          })
        : JSON.stringify({
            label: listedLure || investment ? 'scam' : 'not_scam',
            confidence: 0.9,
            signals: listedLure ? ['malicious_host'] : investment ? ['investment_scam'] : [],
            should_archive: listedLure || investment,
            reason: listedLure ? 'mock_listed_lure' : investment ? 'mock_investment' : 'mock_benign',
          });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: error && error.message ? error.message : String(error),
        }),
      );
    }
  });
}

let nextContactId = 0;

function makeFakeWhatsApp({
  body,
  savedContact = false,
  fromMe = false,
  isGroup = false,
  isMe = false,
}) {
  nextContactId += 1;
  const id = `85261${String(nextContactId).padStart(6, '0')}`;
  const events = [];
  const chatId = `${id}@c.us`;
  const chat = {
    id: { _serialized: chatId },
    isGroup: Boolean(isGroup),
    async archive() {
      events.push('archive');
    },
    async mute() {
      events.push('mute');
    },
  };
  const contact = {
    id: { _serialized: chatId, user: id },
    number: id,
    isMyContact: Boolean(savedContact),
    isMe: Boolean(isMe),
    name: savedContact ? 'Saved contact' : 'New contact',
    pushname: savedContact ? 'Saved contact' : 'New contact',
    async block() {
      events.push('block');
    },
  };
  const msg = {
    fromMe: Boolean(fromMe),
    from: chatId,
    body,
    type: 'chat',
    id: { _serialized: `msg-${id}` },
    _data: { notifyName: contact.pushname },
    async getChat() {
      return chat;
    },
    async getContact() {
      return contact;
    },
  };
  const client = {
    async saveOrEditAddressbookContact(_number, name) {
      events.push('rename');
      contact.name = name;
      contact.isMyContact = true;
    },
  };
  return { msg, chat, contact, client, events };
}

function baseEnv({
  contextOn,
  maskPort,
  llmPort,
  scenarioId,
  runtimeDir,
  cooldownMs = '0',
}) {
  return {
    JEVLIKE_BASE_URL: `http://127.0.0.1:${maskPort}`,
    JEVLIKE_TIMEOUT_MS: '1000',
    LLM_REVIEW_API_URL: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
    LLM_REVIEW_MODEL: 'mock-e2e',
    LLM_REVIEW_API_KEY: 'dummy',
    LLM_REVIEW_ENABLED: 'true',
    LLM_REVIEW_MIN_CONFIDENCE: '0.7',
    LLM_REVIEW_COOLDOWN_MS: String(cooldownMs),
    LLM_REVIEW_COOLDOWN_PATH: path.join(
      runtimeDir,
      `${scenarioId}-cooldown.json`,
    ),
    OPERATOR_MODE: 'auto',
    OPERATOR_MODE_PATH: path.join(runtimeDir, `${scenarioId}-operator-mode.json`),
    REVIEW_QUEUE_PATH: path.join(runtimeDir, `${scenarioId}-review-queue.json`),
    BLOCK_LOG_PATH: path.join(runtimeDir, 'blocks.jsonl'),
    CONTEXT_LLM_ENABLED: contextOn ? '1' : '0',
    WA_ACTION_GAP_MS: '0',
  };
}

async function executeScenario({
  id,
  body,
  contextOn = true,
  savedContact = false,
  fromMe = false,
  isGroup = false,
  isMe = false,
  maskPort,
  llmPort,
  runtimeDir,
  requests,
  setCurrentScenario,
  expected,
  sensitiveDigits,
  messages,
  cooldownMs = '0',
}) {
  setCurrentScenario(id);
  const before = requests.length;
  const messageBodies = Array.isArray(messages) ? messages : [body];
  const fake = makeFakeWhatsApp({
    body: messageBodies[0],
    savedContact,
    fromMe,
    isGroup,
    isMe,
  });
  const chat = await fake.msg.getChat();
  const contact = await fake.msg.getContact();
  const chatId = (chat.id && chat.id._serialized) || fake.msg.from;

  const { JevlikeClient } = require('../lib/jevlike-client');
  const { processIncomingMessage } = require('../lib/handle-incoming');
  const { createRecentContext } = require('../lib/context-llm');
  const { blockAndRename } = require('../lib/wa-actions');
  const { createLlmReviewCooldownStore } = require(
    '../lib/llm-review-cooldown',
  );
  const env = baseEnv({
    contextOn,
    maskPort,
    llmPort,
    scenarioId: id,
    runtimeDir,
    cooldownMs,
  });
  const maskClient = new JevlikeClient({ env });
  const cooldownStore = createLlmReviewCooldownStore({
    filePath: env.LLM_REVIEW_COOLDOWN_PATH,
    env,
  });

  const recentContext = contextOn ? createRecentContext() : null;
  let result = null;
  for (const [index, messageBody] of messageBodies.entries()) {
    fake.msg.body = messageBody;
    fake.msg.id = { _serialized: `msg-${contact.number}-${index + 1}` };
    result = await processIncomingMessage(
      {
        fromMe: Boolean(fake.msg.fromMe),
        isGroup: Boolean(chat.isGroup),
        type: fake.msg.type,
        isMe: Boolean(contact.isMe),
        pushName: fake.msg._data?.notifyName || contact.pushname || contact.name,
        contactName: contact.name || contact.pushname,
        body: fake.msg.body || '',
        chatId,
        savedContact: Boolean(contact.isMyContact),
        messageId: fake.msg.id?._serialized,
      },
      {
        env,
        maskClient,
        resolveNumber: async () => ({
          digits: contact.number,
          unresolvedLid: false,
          source: 'wid',
        }),
        archiveChat: async () => fake.chat.archive(),
        refreshContact: () => fake.msg.getContact(),
        blockContact: (info) =>
          blockAndRename({
            client: fake.client,
            contact: fake.contact,
            chat: fake.chat,
            digits: info && info.digits,
            contactName: info && info.contactName,
            refreshUnsavedContact: () => fake.msg.getContact(),
          }),
        llmCooldownStore: cooldownStore,
        recentContext,
        operatorMode: 'auto',
      },
    );
  }

  const scenarioRequests = requests.slice(before);
  const requestText = scenarioRequests
    .map((record) => JSON.stringify(record.body))
    .join('\n');
  // User-turn content only: the system prompt itself names example tokens
  // like <PHONE_1>, so scanning the whole request would match vacuously.
  const userTurnText = scenarioRequests
    .map((record) => {
      const messages = record.body && Array.isArray(record.body.messages) ? record.body.messages : [];
      return messages.filter((m) => m && m.role === 'user').map((m) => String(m.content || '')).join('\n');
    })
    .join('\n');
  const actual = {
    ignored: Boolean(result && result.ignored),
    action: result && result.decision ? result.decision.action : null,
    archiveReason:
      result && result.decision ? result.decision.archiveReason : null,
    blockReason:
      result && result.decision ? result.decision.blockReason || null : null,
    archived: fake.events.includes('archive'),
    blocked: fake.events.includes('block'),
    deferred: Boolean(result && result.deferred),
    llmCalls: scenarioRequests.length,
    redactedContainsMaskToken: /<[A-Z]+_\d+>/.test(userTurnText),
    rawDigitsPresent: sensitiveDigits
      ? requestText.includes(sensitiveDigits)
      : null,
    maskSkipped:
      result && result.llmTrigger ? result.llmTrigger.skipped : null,
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.deepEqual(
      actual[key],
      expectedValue,
      `${id}: ${key}; actual=${JSON.stringify(actual)}`,
    );
  }
  setCurrentScenario(null);
  process.stdout.write(`ok ${id}\n`);
  return actual;
}

async function main() {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scam-detection-e2e-'),
  );
  const requests = [];
  let currentScenario = null;
  let maskServer = null;
  let mockServer = null;

  try {
    const hostsData = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data/malicious-hosts.json'), 'utf8'),
    );
    const maliciousHost = hostsData.hosts[0];
    assert.equal(typeof maliciousHost, 'string');

    maskServer = await startStubServer({ port: 0 });
    const maskAddress = maskServer.address();
    if (!maskAddress || typeof maskAddress === 'string') {
      throw new Error('mask stub did not bind to a TCP port');
    }
    const maskPort = maskAddress.port;

    mockServer = createMockServer(requests, () => currentScenario);
    const llmPort = await listen(mockServer);
    const deadMaskPort = 0;
    const run = (scenario) =>
      executeScenario({
        ...scenario,
        maskPort: scenario.maskFailure ? deadMaskPort : maskPort,
        llmPort,
        runtimeDir,
        requests,
        setCurrentScenario: (value) => {
          currentScenario = value;
        },
      });
    const maliciousUrl = `https://${maliciousHost}/login`;
    const results = [];

    results.push(
      await run({
        id: 'unsaved-malicious-host',
        body: `登入 ${maliciousUrl}`,
        expected: {
          ignored: false,
          action: 'block',
          archiveReason: 'context_llm',
          blockReason: 'malicious_host',
          archived: true,
          blocked: true,
          llmCalls: 1,
        },
      }),
    );
    results.push(
      await run({
        id: 'warning-malicious-host',
        body: `【防騙提示】以下係假網站 ${maliciousUrl} 千萬唔好撳入去！`,
        expected: {
          ignored: false,
          action: 'ignore',
          archived: false,
          blocked: false,
          llmCalls: 1,
        },
      }),
    );
    results.push(
      await run({
        id: 'saved-malicious-host',
        body: `登入 ${maliciousUrl}`,
        savedContact: true,
        expected: {
          ignored: false,
          action: 'archive',
          archiveReason: 'context_llm',
          archived: false,
          blocked: false,
          deferred: true,
          llmCalls: 1,
        },
      }),
    );
    results.push(
      await run({
        id: 'lookalike-host',
        body: '登入 https://hsbc.evil.com/login',
        expected: {
          ignored: false,
          action: 'ignore',
          archived: false,
          blocked: false,
          llmCalls: 1,
        },
      }),
    );
    results.push(
      await run({
        id: 'soliciting-short-link',
        body: '請提供驗證碼領取投資收益 https://bit.ly/fee',
        contextOn: false,
        expected: {
          ignored: false,
          action: 'archive',
          archiveReason: 'llm_review_scam',
          archived: true,
          blocked: false,
          llmCalls: 1,
        },
      }),
    );
    results.push(
      await run({
        id: 'benign-context-masked-phone',
        body: '我電話係 91234567，今晚食咩呀',
        contextOn: true,
        sensitiveDigits: '91234567',
        expected: {
          ignored: false,
          action: 'ignore',
          archived: false,
          blocked: false,
          llmCalls: 1,
          redactedContainsMaskToken: true,
          rawDigitsPresent: false,
        },
      }),
    );
    results.push(
      await run({
        id: 'benign-primary-masked-phone',
        body: '我電話係 91234567，今晚食咩呀',
        contextOn: false,
        sensitiveDigits: '91234567',
        expected: {
          ignored: false,
          action: 'ignore',
          archived: false,
          blocked: false,
          llmCalls: 1,
          redactedContainsMaskToken: true,
          rawDigitsPresent: false,
        },
      }),
    );
    results.push(
      await run({
        id: 'investment-primary-scam-masked-phone',
        body: '高回報投資，加我 98765432',
        contextOn: false,
        sensitiveDigits: '98765432',
        expected: {
          ignored: false,
          action: 'archive',
          archiveReason: 'llm_review_scam',
          archived: true,
          blocked: false,
          llmCalls: 1,
          redactedContainsMaskToken: true,
          rawDigitsPresent: false,
        },
      }),
    );
    results.push(
      await run({
        id: 'investment-context-first-contact-held',
        body: '高回報投資，加我 98765432',
        contextOn: true,
        sensitiveDigits: '98765432',
        expected: {
          ignored: false,
          action: 'ignore',
          archiveReason: null,
          archived: false,
          blocked: false,
          llmCalls: 1,
          redactedContainsMaskToken: true,
          rawDigitsPresent: false,
        },
      }),
    );
    results.push(
      await run({
        id: 'bank-impersonation-context-first-contact',
        body: '我係銀行職員，請回覆驗證碼，加我 98765432',
        contextOn: true,
        sensitiveDigits: '98765432',
        expected: {
          ignored: false,
          action: 'archive',
          archiveReason: 'context_llm',
          archived: true,
          blocked: false,
          llmCalls: 1,
          redactedContainsMaskToken: true,
          rawDigitsPresent: false,
        },
      }),
    );
    results.push(
      await run({
        id: 'benign-opener-then-investment-context',
        messages: ['你好，請問係陳生嗎？', '高回報投資，加我 WhatsApp 了解'],
        contextOn: true,
        cooldownMs: '600000',
        expected: {
          ignored: false,
          action: 'archive',
          archiveReason: 'context_llm',
          archived: true,
          blocked: false,
          llmCalls: 2,
        },
      }),
    );
    results.push(
      await run({
        id: 'benign-opener-then-investment-primary',
        messages: ['你好，請問係陳生嗎？', '高回報投資，加我 WhatsApp 了解'],
        contextOn: false,
        cooldownMs: '600000',
        expected: {
          ignored: false,
          action: 'archive',
          archiveReason: 'llm_review_scam',
          archived: true,
          blocked: false,
          llmCalls: 2,
        },
      }),
    );
    results.push(
      await run({
        id: 'mask-failure-fail-closed',
        body: '高回報投資，加我 98765432',
        contextOn: true,
        maskFailure: true,
        sensitiveDigits: '98765432',
        expected: {
          ignored: false,
          action: 'ignore',
          archived: false,
          blocked: false,
          llmCalls: 0,
          redactedContainsMaskToken: false,
          rawDigitsPresent: false,
          maskSkipped: 'mask_failed',
        },
      }),
    );
    results.push(
      await run({
        id: 'transfer-code-words-alone',
        body: '轉數快 驗證碼',
        contextOn: true,
        expected: {
          ignored: false,
          action: 'ignore',
          archived: false,
          blocked: false,
          llmCalls: 1,
        },
      }),
    );
    results.push(
      await run({
        id: 'group-message-filtered',
        body: '高回報投資，加我 98765432',
        isGroup: true,
        expected: {
          ignored: true,
          archived: false,
          blocked: false,
          llmCalls: 0,
        },
      }),
    );
    results.push(
      await run({
        id: 'own-message-filtered',
        body: '高回報投資，加我 98765432',
        fromMe: true,
        expected: {
          ignored: true,
          archived: false,
          blocked: false,
          llmCalls: 0,
        },
      }),
    );
    results.push(
      await run({
        id: 'self-contact-filtered',
        body: '高回報投資，加我 98765432',
        isMe: true,
        expected: {
          ignored: true,
          archived: false,
          blocked: false,
          llmCalls: 0,
        },
      }),
    );

    process.stdout.write(
      `E2E passed: ${results.length} scenarios; ${requests.length} LLM requests\n`,
    );
  } finally {
    await closeServer(mockServer);
    await closeServer(maskServer);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
