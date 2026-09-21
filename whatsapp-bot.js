'use strict';

require('dotenv').config();

const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const log = require('./lib/log');
const { createScoreClient, resolveScorer } = require('./lib/scorer');
const { loadRubric } = require('./lib/score-message');
const { TtlCache } = require('./lib/cache');
const {
  processIncomingMessage,
  startupForeignArchive,
  pickSidebarOneToOne,
} = require('./lib/handle-incoming');
const { resolveRealNumber, isLidId } = require('./lib/lid');
const { isNonLocalDial } = require('./lib/foreign-number');
const {
  decideIncomingAction,
  resolveIncomingMessageLabel,
} = require('./lib/decide-incoming');
const { createLlmReviewConfig } = require('./lib/llm-review');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');

function envFlag(name, defaultValue = true) {
  const v = process.env[name];
  if (v == null || v === '') return defaultValue;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

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

async function runStartupForeignScan(client) {
  if (!envFlag('STARTUP_FOREIGN_SCAN', true)) {
    log.info('startup foreign scan disabled');
    return 0;
  }
  const chats = await client.getChats();
  const top = pickSidebarOneToOne(chats, 10);
  log.info(`startup foreign scan of ${top.length} 1:1 chats (no scoring)`);

  const descriptors = [];
  for (const chat of top) {
    let contact;
    try {
      contact = await chat.getContact();
    } catch (err) {
      log.warn('startup getContact failed', { chatId: chat.id?._serialized, error: err.message });
      continue;
    }
    if (contact.isMe) continue;
    const savedContact = Boolean(contact.isMyContact);
    const chatId = chat.id?._serialized || contact.id?._serialized;
    const resolved = await resolveRealNumber(client, chatId, contact);
    descriptors.push({
      chatId,
      chat,
      savedContact,
      digits: resolved.digits,
      unresolvedLid: resolved.unresolvedLid,
      nonLocal: !resolved.unresolvedLid && isNonLocalDial(resolved.digits),
    });
  }

  return startupForeignArchive(descriptors, {
    archiveChat: async (item) => {
      await item.chat.archive();
    },
  });
}

async function handleWaMessage(msg, { client, scoreClient, rubric, cache, llmReview }) {
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
      resolveNumber: () =>
        resolveRealNumber(client, isLidId(chatId) ? chatId : contactId || chatId, contact),
      archiveChat: async () => {
        await chat.archive();
      },
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

  client.on('ready', async () => {
    log.ok('WhatsApp client ready');
    try {
      await runStartupForeignScan(client);
    } catch (err) {
      log.error('startup foreign scan failed', { error: err.message });
    }
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
  const scorer = resolveScorer();
  const scoreClient = createScoreClient();
  const llmReview = createLlmReviewConfig();
  const ttl = Number(process.env.SCORE_CACHE_TTL_MS || 900000);
  const cache = new TtlCache({ ttlMs: ttl });
  const client = createWhatsAppClient();

  log.info('starting WhatsApp scam-risk bot (archive only)', {
    scorer,
    baseURL: scoreClient.baseURL,
    archiveThreshold: rubric.thresholds.archive,
    safeThreshold: rubric.thresholds.safe,
    maxStateChars: rubric.maxStateChars,
    llmReviewEnabled: Boolean(llmReview.enabled),
    llmReviewAll: Boolean(llmReview.reviewAll),
    llmReviewMerge: llmReview.merge,
    llmReviewModel: llmReview.enabled ? llmReview.model : null,
  });

  attachHandlers(client, { scoreClient, rubric, cache, llmReview });
  await client.initialize();
}

module.exports = {
  AUTH_PATH,
  envFlag,
  createScoreClient,
  resolveScorer,
  createWhatsAppClient,
  pickSidebarOneToOne,
  runStartupForeignScan,
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
