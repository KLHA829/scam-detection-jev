'use strict';

require('dotenv').config();

const path = require('path');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const log = require('./lib/log');
const { createMaskClient } = require('./lib/jevlike-client');
const { loadRubric } = require('./lib/score-message');
const { TtlCache } = require('./lib/cache');
const {
  processIncomingMessage,
} = require('./lib/handle-incoming');
const { resolveRealNumber, phoneLookupId } = require('./lib/lid');
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
const { blockAndRename, unblockContact } = require('./lib/wa-actions');
const { createActionPacer } = require('./lib/action-pacer');
const { createThreadContext, contextTurnsFromEnv } = require('./lib/thread-context');
const { createOperatorState } = require('./lib/operator-mode');
const { createReviewQueue } = require('./lib/review-queue');
const { deliverGuidedReview } = require('./lib/deliver-review');
const { applyReviewChoice, applyUnblockChoice } = require('./lib/apply-review-choice');
const { chatListName, composeActionNotice } = require('./lib/action-notice');
const {
  SETUP_INTRO,
  SETUP_POLL_NAME,
  SETUP_OPTIONS,
  UNBLOCK_POLL_NAME,
  UNBLOCK_OPTIONS,
  optionLabels,
} = require('./lib/review-prompt');
const { serializedId, messageIdOf, routeSelfText, routeVote } = require('./lib/self-chat');
const {
  OPERATOR_HELP_TEXT,
  parseOperatorCommand,
  shouldProcessSelfMessageBody,
  resolveUnblockTarget,
  formatRecentBlocksList,
  formatAmbiguousUnblock,
  loadRecentBlocksForCommands,
} = require('./lib/operator-commands');
const {
  loadMaliciousHosts,
  startMaliciousHostsWatcher,
} = require('./lib/malicious-hosts');
const {
  createLlmReviewCooldownStore,
  defaultLlmReviewCooldownPath,
} = require('./lib/llm-review-cooldown');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');

function puppeteerArgs(uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  const args = ['--disable-dev-shm-usage'];
  if (uid === 0) args.push('--no-sandbox', '--disable-setuid-sandbox');
  return args;
}

function createWhatsAppClient() {
  const puppeteer = { args: puppeteerArgs() };
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

function llmConfidenceFromResult(result) {
  const review = result && result.llmReview;
  if (!review || review.ok !== true) return null;
  const conf = Number(review.confidence);
  return Number.isFinite(conf) ? conf : null;
}

async function sendUnblockPoll(client, queue, pacer, row) {
  const wid = selfWid(client);
  if (!wid || !queue || !row || !row.chatId) return null;
  try {
    const sent = await client.sendMessage(
      wid,
      new Poll(UNBLOCK_POLL_NAME, optionLabels(UNBLOCK_OPTIONS), {
        allowMultipleAnswers: false,
      }),
    );
    const pollId = messageIdOf(sent);
    if (!pollId) return null;
    queue.add({
      kind: 'unblock',
      pollId,
      chatId: row.chatId,
      digits: row.digits || row.formattedNumber || null,
      contactName: row.contactName || (row.decision && row.decision.contactName) || null,
      blockContactName:
        row.blockContactName ||
        row.contactName ||
        (row.decision && row.decision.contactName) ||
        null,
      listName: row.listName || null,
      createdAt: new Date().toISOString(),
      resolved: false,
    });
    return pollId;
  } catch (err) {
    log.error('unblock poll failed', {
      chatId: row.chatId,
      error: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

async function sendActionNotice(client, result, { maskClient, llmReview, rubric, listName } = {}) {
  const action = result && result.decision && result.decision.action;
  if (!result || result.ignored || result.deferred) return;
  if (action !== 'archive' && action !== 'block') return;
  const wid = selfWid(client);
  if (!wid) {
    log.warn('self chat unavailable; action notice not sent', { chatId: result.chatId });
    return;
  }
  const blocked = action === 'block' ? Boolean(result.blocked) : false;
  try {
    const notice = await composeActionNotice({
      messages: result.reviewMessages,
      maskClient,
      llmOptions: llmReview,
      env: process.env,
      rubric,
      action,
      blocked,
      archived: Boolean(result.archived),
      listName,
      digits: result.formattedNumber,
      scoreResult: result.scoreResult,
      decision: result.decision,
      heuristic: result.heuristic,
      llmConfidence: llmConfidenceFromResult(result),
      offerUnblock: blocked,
    });
    await client.sendMessage(wid, notice.text);
  } catch (err) {
    log.error('action notice failed', {
      chatId: result.chatId,
      error: err && err.message ? err.message : String(err),
    });
  }
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
  if (!result.ok) queue.release(pollId);
  await pacer.exclusive(async () => {
    await client.sendMessage(wid, result.text);
    if (result.blocked) {
      await sendUnblockPoll(client, queue, pacer, {
        chatId: record.chatId,
        digits: record.digits,
        contactName: record.contactName,
        listName: record.listName,
      });
    }
  });
}

async function confirmUnblockChoice(client, queue, pacer, choice, pollId) {
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
  const result = await applyUnblockChoice(record, choice, {
    exclusive: (fn) => pacer.exclusive(fn),
    pause: () => pacer.pause(),
    getChat: (id) => client.getChatById(id),
    getContact: (chat) => chat.getContact(),
    unblockContact: ({ chat, contact, record: row, digits, blockContactName }) =>
      unblockContact({
        client,
        contact,
        chat,
        digits,
        blockContactName,
        pause: () => pacer.pause(),
      }),
  });
  if (!result.ok) queue.release(pollId);
  await pacer.exclusive(() => client.sendMessage(wid, result.text));
}

async function handleOperatorCommand(cmd, deps, wid) {
  const { client, reviewQueue, pacer } = deps;
  const unblockDeps = {
    exclusive: (fn) => pacer.exclusive(fn),
    pause: () => pacer.pause(),
    getChat: (id) => client.getChatById(id),
    getContact: (chat) => chat.getContact(),
    unblockContact: ({ chat, contact, record: row, digits, blockContactName }) =>
      unblockContact({
        client,
        contact,
        chat,
        digits,
        blockContactName,
        pause: () => pacer.pause(),
      }),
  };

  if (cmd.kind === 'help') {
    await pacer.exclusive(() => client.sendMessage(wid, OPERATOR_HELP_TEXT));
    return;
  }
  if (cmd.kind === 'list_blocks') {
    const rows = loadRecentBlocksForCommands(process.env, 20);
    const text = formatRecentBlocksList(rows, { limit: 5 });
    await pacer.exclusive(() => client.sendMessage(wid, text));
    return;
  }

  const openUnblock =
    reviewQueue && typeof reviewQueue.findOpenUnblock === 'function'
      ? reviewQueue.findOpenUnblock()
      : [];
  const recentBlocks = loadRecentBlocksForCommands(process.env, 20);

  if (cmd.kind === 'keep_blocked') {
    if (openUnblock.length === 0) {
      await pacer.exclusive(() => client.sendMessage(wid, '而家冇待決定嘅解除封鎖問題。'));
      return;
    }
    if (openUnblock.length > 1) {
      await pacer.exclusive(() =>
        client.sendMessage(wid, formatAmbiguousUnblock(openUnblock.map((row) => ({ ...row, displayName: row.listName || row.contactName })))),
      );
      return;
    }
    await confirmUnblockChoice(client, reviewQueue, pacer, 'keep', openUnblock[0].pollId);
    return;
  }

  if (cmd.kind === 'unblock') {
    const target = resolveUnblockTarget(cmd.digits, { openUnblockPolls: openUnblock, recentBlocks });
    if (target.kind === 'not_found') {
      await pacer.exclusive(() => client.sendMessage(wid, '搵唔到符合嘅封鎖紀錄。'));
      return;
    }
    if (target.kind === 'ambiguous') {
      await pacer.exclusive(() => client.sendMessage(wid, formatAmbiguousUnblock(target.candidates)));
      return;
    }
    if (target.kind === 'poll') {
      await confirmUnblockChoice(client, reviewQueue, pacer, 'unblock', target.pollId);
      return;
    }
    const result = await applyUnblockChoice(target.record, 'unblock', unblockDeps);
    await pacer.exclusive(() => client.sendMessage(wid, result.text));
    if (result.ok && reviewQueue && typeof reviewQueue.findOpenUnblock === 'function') {
      for (const poll of reviewQueue.findOpenUnblock()) {
        if (poll.chatId === target.record.chatId) {
          reviewQueue.consume(poll.pollId);
        }
      }
    }
  }
}

async function handleSelfMessage(msg, deps) {
  const body = String(msg.body || '').trim();
  if (!shouldProcessSelfMessageBody(body, Boolean(msg.hasQuotedMsg))) return;
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
    return;
  }
  if (route.kind === 'unblock') {
    await confirmUnblockChoice(
      deps.client,
      deps.reviewQueue,
      deps.pacer,
      route.choice,
      route.pollId,
    );
    return;
  }

  const operatorCmd = parseOperatorCommand(body);
  if (operatorCmd.kind !== 'ignore') {
    await handleOperatorCommand(operatorCmd, deps, wid);
  }
}

async function handleWaMessage(msg, {
  client,
  pacer,
  threadContext,
  recentContext,
  maskClient,
  rubric,
  cache,
  llmReview,
  contextLlm,
  env,
  operator,
  reviewQueue,
  llmCooldownStore,
  isEdit,
}) {
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
  const listName = chatListName(contact, msg);

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
      env,
      maskClient,
      rubric,
      cache,
      llmReview,
      contextLlm,
      threadContext,
      recentContext,
      resolveNumber: () =>
        resolveRealNumber(client, phoneLookupId(chatId, contactId), contact),
      archiveChat: async () => {
        await chat.archive();
      },
      exclusive: (fn) => pacer.exclusive(fn),
      operatorMode: operator ? operator.mode() : 'auto',
      holdBlock: operator ? operator.awaitingChoice() : false,
      pauseAction: () => pacer.pause(),
      llmCooldownStore,
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
  if (result && !result.deferred) {
    await pacer.exclusive(async () => {
      await sendActionNotice(client, result, { maskClient, llmReview, rubric, listName });
      if (result.blocked) {
        await sendUnblockPoll(client, reviewQueue, pacer, {
          ...result,
          listName,
          digits: result.formattedNumber,
          contactName: result.decision && result.decision.contactName,
        });
      }
    });
  }
  if (!result || !result.deferred || !reviewQueue) return result;
  const wid = selfWid(client);
  if (!wid) {
    log.error('guided review has no self chat', { chatId });
    return result;
  }
  try {
    const delivered = await pacer.exclusive(() => deliverGuidedReview({
      result: { ...result, listName },
      maskClient,
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
      allowDuplicate: Boolean(isEdit),
    }));
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

  client.on('message_edit', async (msg, newBody, prevBody) => {
    try {
      if (typeof newBody === 'string') {
        if (newBody === prevBody) return;
        if (msg) msg.body = newBody;
      }
      await handleWaMessage(msg, { client, ...deps, isEdit: true });
    } catch (err) {
      log.error('message edit handler failed', { error: err.message });
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
      } else if (route.kind === 'unblock') {
        await confirmUnblockChoice(
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
  const maskClient = createMaskClient();
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
  const llmCooldownStore = createLlmReviewCooldownStore({
    filePath: defaultLlmReviewCooldownPath(process.env),
    env: process.env,
  });
  const client = createWhatsAppClient();

  try {
    const hosts = loadMaliciousHosts();
    startMaliciousHostsWatcher({
      onReload: (reloaded) => {
        log.info('malicious hosts reloaded', { count: reloaded.length });
      },
      onError: (err) => {
        log.warn('malicious hosts reload failed; keeping previous list', {
          error: err.message,
        });
      },
    });
    log.info('malicious hosts loaded', { count: hosts.length });
  } catch (err) {
    log.error('malicious hosts load failed', { error: err.message });
    process.exit(1);
  }

  log.info('starting WhatsApp scam-risk bot (mask + LLM primary, malicious-host block)', {
    maskWorker: maskClient.baseURL,
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
    maskClient,
    rubric,
    cache,
    llmReview,
    pacer,
    threadContext,
    recentContext,
    operator,
    reviewQueue,
    llmCooldownStore,
  });
  await client.initialize();
}

module.exports = {
  AUTH_PATH,
  createMaskClient,
  createWhatsAppClient,
  puppeteerArgs,
  handleWaMessage,
  attachHandlers,
  main,
  decideIncomingAction,
  resolveIncomingMessageLabel,
};

if (require.main === module) {
  main().catch((err) => {
    log.error('fatal', { error: err.message });
    process.exit(1);
  });
}
