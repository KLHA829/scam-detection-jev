'use strict';

require('dotenv').config();

const path = require('path');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const log = require('./lib/log');
const { createScoreClient } = require('./lib/scorer');
const { loadRubric } = require('./lib/score-message');
const { TtlCache } = require('./lib/cache');
const {
  processIncomingMessage,
} = require('./lib/handle-incoming');
const { resolveRealNumber, isLidId } = require('./lib/lid');
const {
  decideIncomingAction,
  resolveIncomingMessageLabel,
} = require('./lib/decide-incoming');
const { createLlmReviewConfig } = require('./lib/llm-review');
const {
  contextLlmEnabled,
  contextLlmMessageLimit,
  createRecentContext,
} = require('./lib/context-llm');
const { blockAndRename } = require('./lib/wa-actions');
const { createActionPacer } = require('./lib/action-pacer');
const { createThreadContext, contextTurnsFromEnv } = require('./lib/thread-context');
const { createOperatorState } = require('./lib/operator-mode');
const { createReviewQueue } = require('./lib/review-queue');
const { deliverGuidedReview } = require('./lib/deliver-review');
const { applyReviewChoice } = require('./lib/apply-review-choice');
const {
  SETUP_INTRO,
  SETUP_POLL_NAME,
  SETUP_OPTIONS,
  optionLabels,
} = require('./lib/review-prompt');
const { serializedId, routeSelfText, routeVote } = require('./lib/self-chat');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');

function createWhatsAppClient() {
  const puppeteer = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    puppeteer,
  });
}

function selfWid(client) {
  return serializedId(client && client.info && client.info.wid);
}

async function sendSetupPoll(client, operator, { reconfigure = false } = {}) {
  const wid = selfWid(client);
  if (!wid) {
    log.warn('self chat unavailable; operator setup not sent');
    return null;
  }
  await client.sendMessage(
    wid,
    reconfigure ? '再揀一次處理方式。未揀之前維持而家嘅模式。' : SETUP_INTRO,
  );
  const sent = await client.sendMessage(
    wid,
    new Poll(SETUP_POLL_NAME, optionLabels(SETUP_OPTIONS), {
      allowMultipleAnswers: false,
    }),
  );
  const id = serializedId(sent && sent.id);
  if (!id) return null;
  if (reconfigure) operator.rememberReconfigurePoll(id);
  else operator.rememberSetupPoll(id);
  return id;
}

async function confirmOperatorMode(client, operator, mode) {
  const wid = selfWid(client);
  if (!wid) return;
  if (operator.pinned()) {
    await client.sendMessage(wid, '模式由 OPERATOR_MODE 釘死。改環境變數先至可以轉。');
    return;
  }
  operator.choose(mode);
  await client.sendMessage(
    wid,
    mode === 'guided'
      ? '已改為逐條問你。之後每條可疑訊息會轉發嚟呢度。'
      : '已改為自動封鎖同封存。',
  );
}

async function confirmReviewChoice(client, queue, pacer, choice, pollId) {
  const wid = selfWid(client);
  const existing = queue.get(pollId);
  if (!existing || !wid) return;
  if (existing.resolved) {
    await client.sendMessage(wid, '已經處理咗。');
    return;
  }
  const record = queue.consume(pollId);
  if (!record) {
    await client.sendMessage(wid, '已經處理咗。');
    return;
  }
  const result = await applyReviewChoice(record, choice, {
    exclusive: (fn) => pacer.exclusive(fn),
    pause: () => pacer.pause(),
    getChat: (id) => client.getChatById(id),
    getContact: (chat) => chat.getContact(),
    archiveChat: async (chat) => {
      await chat.archive();
    },
    blockContact: ({ chat, contact, record: row, contactName }) =>
      blockAndRename({
        client,
        contact,
        chat,
        digits: row.digits,
        contactName,
        pause: () => pacer.pause(),
      }),
  });
  await client.sendMessage(wid, result.text);
}

async function handleSelfMessage(msg, deps) {
  const body = String(msg.body || '').trim();
  if (body !== '設定' && !msg.hasQuotedMsg) return;
  const wid = selfWid(deps.client);
  if (!wid) return;
  let isSelf = false;
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const chatId = serializedId(chat && chat.id);
    isSelf = chatId === wid || Boolean(contact && contact.isMe);
  } catch (err) {
    log.warn('self chat check failed', { error: err.message });
    return;
  }
  if (!isSelf) return;

  let quotedId = null;
  if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
    try {
      const quoted = await msg.getQuotedMessage();
      quotedId = serializedId(quoted && quoted.id);
    } catch (err) {
      log.warn('quoted message unavailable', { error: err.message });
    }
  }
  const route = routeSelfText({
    body,
    quotedId,
    operator: deps.operator,
    queue: deps.reviewQueue,
  });
  if (route.kind === 'ignore') return;
  if (route.kind === 'reconfigure') {
    if (deps.operator.pinned()) {
      await deps.client.sendMessage(wid, '模式由 OPERATOR_MODE 釘死。改環境變數先至可以轉。');
      return;
    }
    await sendSetupPoll(deps.client, deps.operator, { reconfigure: true });
    return;
  }
  if (route.kind === 'setup') {
    await confirmOperatorMode(deps.client, deps.operator, route.mode);
    return;
  }
  if (route.kind === 'already') {
    await deps.client.sendMessage(wid, '已經處理咗。');
    return;
  }
  if (route.kind === 'review') {
    await confirmReviewChoice(
      deps.client,
      deps.reviewQueue,
      deps.pacer,
      route.choice,
      route.pollId,
    );
  }
}

async function handleWaMessage(msg, { client, pacer, threadContext, recentContext, scoreClient, rubric, cache, llmReview, operator, reviewQueue }) {
  let chat;
  let contact;
  try {
    chat = await msg.getChat();
    contact = await msg.getContact();
  } catch (err) {
    log.error('failed to load chat/contact', { error: err.message });
    return null;
  }

  const chatId = (chat.id && chat.id._serialized) || msg.from;
  const contactId = contact.id && contact.id._serialized;

  const result = await processIncomingMessage(
    {
      fromMe: Boolean(msg.fromMe),
      isGroup: Boolean(chat.isGroup),
      type: msg.type,
      isMe: Boolean(contact.isMe),
      pushName: msg._data?.notifyName || contact.pushname || contact.name,
      contactName: contact.name || contact.pushname,
      body: msg.body || '',
      chatId,
      savedContact: Boolean(contact.isMyContact),
      messageId: msg.id?._serialized || msg.id?.id,
    },
    {
      scoreClient,
      rubric,
      cache,
      llmReview,
      threadContext,
      recentContext,
      resolveNumber: () =>
        resolveRealNumber(client, isLidId(chatId) ? chatId : contactId || chatId, contact),
      archiveChat: async () => {
        await chat.archive();
      },
      exclusive: (fn) => pacer.exclusive(fn),
      operatorMode: operator ? operator.mode() : 'auto',
      holdBlock: operator ? operator.awaitingChoice() : false,
      pauseAction: () => pacer.pause(),
      blockContact: (info) =>
        blockAndRename({
          client,
          contact,
          chat,
          digits: info && info.digits,
          contactName: info && info.contactName,
          pause: () => pacer.pause(),
        }),
    },
  );
  if (!result || !result.deferred || !reviewQueue) return result;
  const wid = selfWid(client);
  if (!wid) {
    log.error('guided review has no self chat', { chatId });
    return result;
  }
  try {
    const delivered = await deliverGuidedReview({
      result,
      scoreClient,
      llmReview,
      env: process.env,
      rubric,
      queue: reviewQueue,
      forward: () => msg.forward(wid),
      sendText: (text) => client.sendMessage(wid, text),
      sendPoll: async (name, options) =>
        client.sendMessage(
          wid,
          new Poll(name, options, { allowMultipleAnswers: false }),
        ),
    });
    if (delivered && delivered.forwardError) {
      log.warn('guided forward or poll failed', {
        chatId,
        error: delivered.forwardError,
      });
    }
  } catch (err) {
    log.error('guided review failed', { chatId, error: err.message });
  }
  return result;
}

function attachHandlers(client, deps) {
  client.on('qr', (qr) => {
    log.info('scan QR to link WhatsApp Web');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    log.ok('WhatsApp session authenticated');
  });

  client.on('auth_failure', (m) => {
    log.error('auth failure', m);
  });

  client.on('ready', () => {
    log.ok('WhatsApp client ready');
    if (!deps.operator || !deps.operator.needsSetup()) return;
    sendSetupPoll(client, deps.operator).catch((err) => {
      log.error('operator setup failed', { error: err.message });
    });
  });

  client.on('message', async (msg) => {
    try {
      await handleWaMessage(msg, { client, ...deps });
    } catch (err) {
      log.error('message handler failed', { error: err.message });
    }
  });

  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe || !deps.operator) return;
      await handleSelfMessage(msg, { client, ...deps });
    } catch (err) {
      log.error('self chat handler failed', { error: err.message });
    }
  });

  client.on('vote_update', async (vote) => {
    try {
      if (!deps.operator || !deps.reviewQueue) return;
      const route = routeVote(vote, {
        operator: deps.operator,
        queue: deps.reviewQueue,
      });
      if (route.kind === 'setup') {
        await confirmOperatorMode(client, deps.operator, route.mode);
      } else if (route.kind === 'already') {
        const wid = selfWid(client);
        if (wid) await client.sendMessage(wid, '已經處理咗。');
      } else if (route.kind === 'review') {
        await confirmReviewChoice(
          client,
          deps.reviewQueue,
          deps.pacer,
          route.choice,
          route.pollId,
        );
      }
    } catch (err) {
      log.error('vote handler failed', { error: err.message });
    }
  });

  client.on('disconnected', (reason) => {
    log.warn('disconnected', { reason });
  });
}

async function main() {
  const rubricPath = process.env.RUBRIC_PATH || undefined;
  const rubric = loadRubric(rubricPath);
  const scoreClient = createScoreClient();
  const llmReview = createLlmReviewConfig();
  const contextOn = contextLlmEnabled();
  const ttl = Number(process.env.SCORE_CACHE_TTL_MS || 900000);
  const cache = new TtlCache({ ttlMs: ttl });
  const pacer = createActionPacer();
  const threadContext = createThreadContext({ turns: contextTurnsFromEnv() });
  const recentContext = contextOn
    ? createRecentContext({ limit: contextLlmMessageLimit() })
    : null;
  const operator = createOperatorState();
  const reviewQueue = createReviewQueue();
  const client = createWhatsAppClient();

  log.info('starting WhatsApp scam-risk bot (jevlike scoring, graded block)', {
    scorer: 'jevlike',
    baseURL: scoreClient.baseURL,
    archiveThreshold: rubric.thresholds.archive,
    blockThreshold: rubric.thresholds.block,
    safeThreshold: rubric.thresholds.safe,
    waActionGapMs: pacer.gapMs,
    contextTurns: threadContext.turns,
    llmReviewEnabled: Boolean(llmReview.enabled),
    llmReviewAll: Boolean(llmReview.reviewAll),
    llmReviewMerge: llmReview.merge,
    llmReviewModel: llmReview.enabled ? llmReview.model : null,
    contextLlmEnabled: contextOn,
    contextLlmMessages: recentContext ? recentContext.limit : 0,
    operatorMode: operator.mode(),
    operatorSetup: operator.needsSetup(),
  });

  attachHandlers(client, {
    scoreClient,
    rubric,
    cache,
    llmReview,
    pacer,
    threadContext,
    recentContext,
    operator,
    reviewQueue,
  });
  await client.initialize();
}

module.exports = {
  AUTH_PATH,
  createScoreClient,
  createWhatsAppClient,
  handleWaMessage,
  attachHandlers,
  decideIncomingAction,
  resolveIncomingMessageLabel,
};

if (require.main === module) {
  main().catch((err) => {
    log.error('fatal', { error: err.message });
    process.exit(1);
  });
}
