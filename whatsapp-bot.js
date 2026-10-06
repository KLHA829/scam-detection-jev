'use strict';

require('dotenv').config();

const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
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
  createOpeningContext,
} = require('./lib/context-llm');
const { blockAndRename } = require('./lib/wa-actions');
const { createActionPacer } = require('./lib/action-pacer');
const { createThreadContext, contextTurnsFromEnv } = require('./lib/thread-context');

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

async function handleWaMessage(msg, { client, pacer, threadContext, openingContext, scoreClient, rubric, cache, llmReview }) {
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

  return processIncomingMessage(
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
      openingContext,
      resolveNumber: () =>
        resolveRealNumber(client, isLidId(chatId) ? chatId : contactId || chatId, contact),
      archiveChat: async () => {
        await chat.archive();
      },
      exclusive: (fn) => pacer.exclusive(fn),
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
  });

  client.on('message', async (msg) => {
    try {
      await handleWaMessage(msg, { client, ...deps });
    } catch (err) {
      log.error('message handler failed', { error: err.message });
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
  const openingContext = contextOn
    ? createOpeningContext({ limit: contextLlmMessageLimit() })
    : null;
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
    contextLlmMessages: openingContext ? openingContext.limit : 0,
  });

  attachHandlers(client, {
    scoreClient,
    rubric,
    cache,
    llmReview,
    pacer,
    threadContext,
    openingContext,
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
