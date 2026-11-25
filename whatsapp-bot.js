'use strict';

require('dotenv').config();

const path = require('path');
const qrcode = require('qrcode-terminal');

const log = require('./lib/log');
const {
  createWhatsAppTransport,
  ensureTransport,
  isWaTransport,
  normalizeMessage,
  createWwebjsClient,
  puppeteerArgs,
} = require('./lib/wa-transport');
const { createMaskClient } = require('./lib/jevlike-client');
const {
  processIncomingMessage,
  recordOutgoingMessage,
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
const { blockAndRename, clearUnsavedContactLabel, labelUnsavedContact, unblockContact } = require('./lib/wa-actions');
const { savedContactStatus } = require('./lib/block-policy');
const { loadSenderContact } = require('./lib/sender-contact');
const { createBotContactNames, defaultBotContactNamesPath } = require('./lib/bot-contact-names');
const { createActionPacer } = require('./lib/action-pacer');
const { createThreadContext, contextTurnsFromEnv } = require('./lib/thread-context');
const { createOperatorState } = require('./lib/operator-mode');
const { createReviewQueue } = require('./lib/review-queue');
const { deliverGuidedReview, invalidatePendingGuidedReview } = require('./lib/deliver-review');
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
const { shouldIgnoreMessage } = require('./lib/filters');
const {
  OPERATOR_HELP_TEXT,
  parseOperatorCommand,
  shouldProcessSelfMessageBody,
  resolveUnblockCommand,
  formatRecentBlocksList,
  formatAmbiguousUnblock,
  formatAmbiguousKeepBlocked,
  loadRecentBlocksForCommands,
} = require('./lib/operator-commands');
const {
  loadMaliciousHosts,
  startMaliciousHostsWatcher,
} = require('./lib/malicious-hosts');
const {
  createLlmReviewCooldownStore,
  defaultLlmReviewCooldownPath,
  recordChatLlmReviewSuccess,
} = require('./lib/llm-review-cooldown');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const VOIDED_POLL_TEXT = '呢個投票已作廢：對方改咗訊息，唔會封存或封鎖。';

function createWhatsAppClient() {
  return createWwebjsClient({ authPath: AUTH_PATH });
}

function selfWid(transport) {
  if (!transport) return null;
  if (typeof transport.getSelfWid === 'function') return transport.getSelfWid();
  return serializedId(transport.info && transport.info.wid);
}

function llmConfidenceFromResult(result) {
  const review = result && result.llmReview;
  if (!review || review.ok !== true) return null;
  const conf = Number(review.confidence);
  return Number.isFinite(conf) ? conf : null;
}

async function sendUnblockPoll(transport, queue, pacer, row) {
  const wid = selfWid(transport);
  if (!wid || !queue || !row || !row.chatId) return null;
  try {
    const sent = await transport.sendPoll(wid, {
      name: UNBLOCK_POLL_NAME,
      options: optionLabels(UNBLOCK_OPTIONS),
      allowMultipleAnswers: false,
    });
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
      renamed: row.renamed,
      savedContact: row.savedContact,
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

async function sendActionNotice(transport, result, { maskClient, llmReview, listName, pacer, reviewQueue } = {}) {
  const action = result && result.decision && result.decision.action;
  if (!result || result.ignored || result.deferred) return;
  if (action !== 'archive' && action !== 'block') return;
  const wid = selfWid(transport);
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
      action,
      blocked,
      archived: Boolean(result.archived),
      listName,
      digits: result.formattedNumber,
      decision: result.decision,
      heuristic: result.heuristic,
      llmConfidence: llmConfidenceFromResult(result),
      offerUnblock: blocked,
    });
    await pacer.exclusive(async () => {
      try {
        await transport.sendText(wid, notice.text);
      } catch (err) {
        log.error('action notice failed', {
          chatId: result.chatId,
          error: err && err.message ? err.message : String(err),
        });
      }
      if (result.blocked) {
        await sendUnblockPoll(transport, reviewQueue, pacer, {
          ...result,
          listName,
          digits: result.formattedNumber,
          contactName: result.decision && result.decision.contactName,
          renamed: result.renamed,
          savedContact: result.savedContact,
        });
      }
    });
  } catch (err) {
    log.error('action notice failed', {
      chatId: result.chatId,
      error: err && err.message ? err.message : String(err),
    });
  }
}

async function sendSetupPoll(transport, operator, { reconfigure = false } = {}) {
  const wid = selfWid(transport);
  if (!wid) {
    log.warn('self chat unavailable; operator setup not sent');
    return null;
  }
  await transport.sendText(
    wid,
    reconfigure ? '再揀一次處理方式。未揀之前維持而家嘅模式。' : SETUP_INTRO,
  );
  const sent = await transport.sendPoll(wid, {
    name: SETUP_POLL_NAME,
    options: optionLabels(SETUP_OPTIONS),
    allowMultipleAnswers: false,
  });
  const id = messageIdOf(sent);
  if (!id) return null;
  if (reconfigure) operator.rememberReconfigurePoll(id);
  else operator.rememberSetupPoll(id);
  return id;
}

async function confirmOperatorMode(transport, operator, mode) {
  const wid = selfWid(transport);
  if (!wid) return;
  if (operator.pinned()) {
    await transport.sendText(wid, '模式由 OPERATOR_MODE 釘死。改環境變數先至可以轉。');
    return;
  }
  operator.choose(mode);
  await transport.sendText(
    wid,
    mode === 'guided'
      ? '已改為逐條問你。之後每條可疑訊息會轉發嚟呢度。'
      : '已改為自動封鎖同封存。',
  );
}

async function confirmReviewChoice(transport, queue, pacer, choice, pollId, { botContactNames } = {}) {
  const wid = selfWid(transport);
  const existing = queue.get(pollId);
  if (!existing || !wid) return;
  if (existing.resolved) {
    await transport.sendText(wid, '已經處理咗。');
    return;
  }
  let record;
  try {
    record = queue.consume(pollId);
  } catch (err) {
    log.error('review choice save failed', { error: err.message });
    await pacer.exclusive(() => transport.sendText(wid, '儲存選擇失敗，未執行操作。請稍後再試。'));
    return;
  }
  if (!record) {
    await transport.sendText(wid, queue.isPendingVoid(pollId) ? VOIDED_POLL_TEXT : '已經處理咗。');
    return;
  }
  const result = await applyReviewChoice(record, choice, {
    exclusive: (fn) => pacer.exclusive(fn),
    pause: () => pacer.pause(),
    getChat: (id) => transport.getChat(id),
    getContact: async (chat) => {
      const contact = await transport.getChatContact(chat);
      return (await loadSenderContact(transport, { senderId: record.chatId, contact, botContactNames })) || contact;
    },
    refreshContact: async (chat) =>
      loadSenderContact(transport, {
        senderId: record.chatId,
        contact: await transport.getChatContact(chat),
        botContactNames,
      }),
    botContactNames,
    archiveChat: async (chat) => {
      await transport.archiveChat(chat);
    },
    blockContact: ({ chat, contact, record: row, contactName, canRenameContact }) =>
      blockAndRename({
        client: transport,
        contact,
        chat,
        digits: row.digits,
        contactName,
        canRenameContact,
        pause: () => pacer.pause(),
        botContactNames,
        extraIds: [record.chatId],
      }),
  });
  if (!result.ok) {
    try {
      queue.release(pollId);
    } catch (err) {
      log.error('review choice release failed', { pollId, error: err && err.message ? err.message : String(err) });
    }
  }
  await pacer.exclusive(async () => {
    await transport.sendText(wid, result.text);
    if (result.blocked) {
      await sendUnblockPoll(transport, queue, pacer, {
        chatId: record.chatId,
        digits: record.digits,
        contactName: record.contactName,
        blockContactName: record.contactName,
        renamed: result.renamed,
        savedContact: result.savedContact,
        listName: record.listName,
      });
    }
  });
}

async function confirmUnblockChoice(transport, queue, pacer, choice, pollId, { botContactNames } = {}) {
  const wid = selfWid(transport);
  const existing = queue.get(pollId);
  if (!existing || !wid) return;
  if (existing.resolved) {
    await transport.sendText(wid, '已經處理咗。');
    return;
  }
  let record;
  try {
    record = queue.consume(pollId);
  } catch (err) {
    log.error('unblock choice save failed', { error: err.message });
    await pacer.exclusive(() => transport.sendText(wid, '儲存選擇失敗，未執行操作。請稍後再試。'));
    return;
  }
  if (!record) {
    await transport.sendText(wid, '已經處理咗。');
    return;
  }
  const resolveContact = async (chat) => {
    const raw = await transport.getChatContact(chat);
    return (await loadSenderContact(transport, { senderId: record.chatId, contact: raw, botContactNames })) || raw;
  };
  const refreshVerifiedContact = async (chat) =>
    loadSenderContact(transport, {
      senderId: record.chatId,
      contact: await transport.getChatContact(chat),
      botContactNames,
    });
  const result = await applyUnblockChoice(record, choice, {
    exclusive: (fn) => pacer.exclusive(fn),
    pause: () => pacer.pause(),
    getChat: (id) => transport.getChat(id),
    getContact: resolveContact,
    unblockContact: ({ chat, contact, digits, blockContactName, renamed, savedContact }) =>
      unblockContact({
        client: transport,
        contact,
        chat,
        digits,
        blockContactName,
        renamed,
        savedContact,
        pause: () => pacer.pause(),
        refreshContact: refreshVerifiedContact,
        botContactNames,
        extraIds: [record.chatId],
      }),
  });
  if (!result.ok) {
    try {
      queue.release(pollId);
    } catch (err) {
      log.error('unblock choice release failed', { pollId, error: err && err.message ? err.message : String(err) });
    }
  }
  await pacer.exclusive(() => transport.sendText(wid, result.text));
}

async function handleOperatorCommand(cmd, deps, wid) {
  const { transport, reviewQueue, pacer, botContactNames } = deps;
  const unblockDeps = {
    exclusive: (fn) => pacer.exclusive(fn),
    pause: () => pacer.pause(),
    getChat: (id) => transport.getChat(id),
    getContact: async (chat, row) => {
      const raw = await transport.getChatContact(chat);
      return (await loadSenderContact(transport, { senderId: row && row.chatId, contact: raw, botContactNames })) || raw;
    },
    unblockContact: ({ chat, contact, record: row, digits, blockContactName, renamed, savedContact }) =>
      unblockContact({
        client: transport,
        contact,
        chat,
        digits,
        blockContactName,
        renamed,
        savedContact,
        pause: () => pacer.pause(),
        refreshContact: async (c) =>
          loadSenderContact(transport, {
            senderId: row && row.chatId,
            contact: await transport.getChatContact(c),
            botContactNames,
          }),
        botContactNames,
        extraIds: row && row.chatId ? [row.chatId] : [],
      }),
  };

  if (cmd.kind === 'help') {
    await pacer.exclusive(() => transport.sendText(wid, OPERATOR_HELP_TEXT));
    return;
  }
  if (cmd.kind === 'list_blocks') {
    const rows = loadRecentBlocksForCommands(process.env, 20);
    const text = formatRecentBlocksList(rows, { limit: 5 });
    await pacer.exclusive(() => transport.sendText(wid, text));
    return;
  }

  const openUnblock =
    reviewQueue && typeof reviewQueue.findOpenUnblock === 'function'
      ? reviewQueue.findOpenUnblock()
      : [];

  if (cmd.kind === 'keep_blocked') {
    if (openUnblock.length === 0) {
      await pacer.exclusive(() => transport.sendText(wid, '而家冇待決定嘅解除封鎖問題。'));
      return;
    }
    if (openUnblock.length > 1) {
      await pacer.exclusive(() =>
        transport.sendText(wid, formatAmbiguousKeepBlocked(openUnblock.map((row) => ({ ...row, displayName: row.listName || row.contactName })))),
      );
      return;
    }
    await confirmUnblockChoice(transport, reviewQueue, pacer, 'keep', openUnblock[0].pollId, {
      botContactNames,
    });
    return;
  }

  if (cmd.kind === 'unblock') {
    const target = resolveUnblockCommand(cmd.digits, { openUnblockPolls: openUnblock });
    if (target.kind === 'not_found') {
      await pacer.exclusive(() => transport.sendText(wid, '搵唔到符合嘅封鎖紀錄。'));
      return;
    }
    if (target.kind === 'ambiguous') {
      await pacer.exclusive(() => transport.sendText(wid, formatAmbiguousUnblock(target.candidates)));
      return;
    }
    if (target.kind === 'poll') {
      await confirmUnblockChoice(transport, reviewQueue, pacer, 'unblock', target.pollId, {
        botContactNames,
      });
      return;
    }
    const result = await applyUnblockChoice(target.record, 'unblock', unblockDeps);
    await pacer.exclusive(() => transport.sendText(wid, result.text));
    if (result.ok && reviewQueue && typeof reviewQueue.findOpenUnblock === 'function') {
      for (const poll of reviewQueue.findOpenUnblock()) {
        if (poll.chatId === target.record.chatId) {
          reviewQueue.consume(poll.pollId);
        }
      }
    }
  }
}

async function isSelfChatId(transport, chatId) {
  if (!transport || !chatId) return false;
  return transport.isSelfChatId(chatId);
}

async function handleSelfMessage(msg, deps) {
  const body = String(msg.body || '').trim();
  if (!shouldProcessSelfMessageBody(body, Boolean(msg.hasQuotedMsg))) return;
  const wid = selfWid(deps.transport);
  if (!wid) return;
  let isSelf;
  try {
    const chat = await msg.getChat();
    const chatId = serializedId(chat && chat.id);
    isSelf = await isSelfChatId(deps.transport, chatId);
  } catch (err) {
    log.warn('self chat check failed', { error: err.message });
    return;
  }
  if (!isSelf) return;

  let quotedId = null;
  if (msg.hasQuotedMsg && typeof msg.getQuotedMessageId === 'function') {
    try {
      quotedId = await msg.getQuotedMessageId();
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
      await deps.transport.sendText(wid, '模式由 OPERATOR_MODE 釘死。改環境變數先至可以轉。');
      return;
    }
    await sendSetupPoll(deps.transport, deps.operator, { reconfigure: true });
    return;
  }
  if (route.kind === 'setup') {
    await confirmOperatorMode(deps.transport, deps.operator, route.mode);
    return;
  }
  if (route.kind === 'already') {
    await deps.transport.sendText(wid, '已經處理咗。');
    return;
  }
  if (route.kind === 'voided') {
    await deps.transport.sendText(wid, VOIDED_POLL_TEXT);
    return;
  }
  if (route.kind === 'review') {
    await confirmReviewChoice(
      deps.transport,
      deps.reviewQueue,
      deps.pacer,
      route.choice,
      route.pollId,
      { botContactNames: deps.botContactNames },
    );
    return;
  }
  if (route.kind === 'unblock') {
    await confirmUnblockChoice(
      deps.transport,
      deps.reviewQueue,
      deps.pacer,
      route.choice,
      route.pollId,
      { botContactNames: deps.botContactNames },
    );
    return;
  }

  const operatorCmd = parseOperatorCommand(body);
  if (operatorCmd.kind !== 'ignore') {
    await handleOperatorCommand(operatorCmd, deps, wid);
  }
}

function incomingMessageId(msg) {
  if (!msg) return null;
  if (typeof msg.id === 'string') return msg.id;
  return msg?.id?._serialized || msg?.id?.id || null;
}

async function recordOwnMessage(msg, { transport, recentContext, editedFrom = null }) {
  if (!recentContext) return;
  let chat;
  try {
    chat = await msg.getChat();
  } catch (err) {
    log.warn('own message chat lookup failed', { error: err.message });
    return;
  }
  const chatId = serializedId(chat && chat.id);
  if (!chatId || chatId === selfWid(transport)) return;
  if (/@lid$/i.test(chatId)) {
    try {
      if (await isSelfChatId(transport, chatId)) return;
    } catch {}
  }
  recordOutgoingMessage(
    {
      type: msg.type,
      isGroup: Boolean(chat.isGroup),
      isChannel: Boolean(chat.isChannel),
      chatId,
      body: msg.body || '',
      messageId: incomingMessageId(msg),
      editedFrom,
    },
    { recentContext },
  );
}

// The sender contact is best effort: when it cannot be read, the message is
// still reviewed and its saved status is unknown, which never auto-acts.
async function loadMessageContact(msg) {
  try {
    return (await msg.getContact()) || null;
  } catch (err) {
    log.error('failed to load contact', { error: err.message });
    return null;
  }
}

async function handleWaMessage(rawMsg, {
  client,
  transport: providedTransport,
  pacer,
  threadContext,
  recentContext,
  maskClient,
  llmReview,
  contextLlm,
  env,
  operator,
  reviewQueue,
  llmCooldownStore,
  botContactNames,
  bypassLlmCooldown = false,
  editedFrom = null,
  isCurrent = () => true,
}) {
  const rawDriver = providedTransport || client;
  const transport = ensureTransport(rawDriver);
  const msg = rawDriver && !isWaTransport(rawDriver) ? normalizeMessage(rawMsg) : rawMsg;
  const preIgnore = shouldIgnoreMessage({
    fromMe: Boolean(msg.fromMe),
    type: msg.type,
    chatId: msg.from,
    from: msg.from,
  });
  if (preIgnore.ignore) {
    log.info(`skip message (${preIgnore.reason})`, { chatId: msg.from || null });
    return { ignored: true, reason: preIgnore.reason };
  }

  let chat;
  try {
    chat = await msg.getChat();
  } catch (err) {
    log.error('failed to load chat', { error: err.message });
    return null;
  }
  const contact = await loadMessageContact(msg);

  const chatId = serializedId(chat && chat.id) || msg.from;
  const contactId = serializedId(contact && contact.id);
  const senderId = msg.author || msg.from || chatId;
  const extraIds = [senderId, chatId].filter(Boolean);
  // Without the sender's own record a LID saved flag is unread, so the saved
  // status stays unknown even when the phone-number contact says unsaved.
  const readSender = async (senderContact) =>
    senderContact ? loadSenderContact(transport, { senderId, contact: senderContact, botContactNames }) : null;
  const sender = await readSender(contact);
  const listName = chatListName(sender || contact, msg);
  const refreshSender = async () => readSender(await loadMessageContact(msg));

  const result = await processIncomingMessage(
    {
      fromMe: Boolean(msg.fromMe),
      isGroup: Boolean(chat.isGroup),
      isChannel: Boolean(chat.isChannel),
      type: msg.type,
      isMe: Boolean(contact && contact.isMe),
      pushName: msg.notifyName || (msg._data && msg._data.notifyName) || (contact && (contact.pushname || contact.name)),
      contactName: (sender && sender.name) || (contact && (contact.name || contact.pushname)),
      body: msg.body || '',
      isForwarded: msg.isForwarded === true,
      chatId,
      savedContact: savedContactStatus(sender, botContactNames),
      messageId: incomingMessageId(msg),
    },
    {
      env,
      maskClient,
      llmReview,
      contextLlm,
      threadContext,
      recentContext,
      resolveNumber: () =>
        resolveRealNumber(transport, phoneLookupId(chatId, contactId), contact),
      archiveChat: async () => {
        if (transport) await transport.archiveChat(chat);
        else await chat.archive();
      },
      refreshContact: refreshSender,
      exclusive: (fn) => pacer.exclusive(fn),
      operatorMode: operator ? operator.mode() : 'auto',
      holdBlock: operator ? operator.awaitingChoice() : false,
      pauseAction: () => pacer.pause(),
      llmCooldownStore,
      botContactNames,
      bypassLlmCooldown,
      deferCooldownRecord: Boolean(reviewQueue),
      editedFrom,
      isCurrent,
      blockContact: (info) =>
        blockAndRename({
          client: transport,
          contact,
          chat,
          digits: info && info.digits,
          contactName: info && info.contactName,
          pause: () => pacer.pause(),
          refreshUnsavedContact: refreshSender,
          botContactNames,
          extraIds,
          isCurrent,
        }),
      hasContactLabel: (info) =>
        Boolean(
          botContactNames &&
            info &&
            (botContactNames.wroteForNumber(info.digits, info.contactName) ||
              (sender &&
                botContactNames.wrote(sender) &&
                sender.name &&
                sender.name.trim() === info.contactName)),
        ),
      clearContactLabel: (info) =>
        clearUnsavedContactLabel({
          client: transport,
          digits: info && info.digits,
          contactName: info && info.contactName,
          pause: () => pacer.pause(),
          refreshUnsavedContact: refreshSender,
          botContactNames,
          extraIds,
          isCurrent,
        }),
      labelContact: (info) =>
        labelUnsavedContact({
          client: transport,
          digits: info && info.digits,
          contactName: info && info.contactName,
          pause: () => pacer.pause(),
          refreshUnsavedContact: refreshSender,
          botContactNames,
          extraIds,
          isCurrent,
        }),
    },
  );
  if (result && !result.deferred && !result.stale && (isCurrent() || result.blocked || result.archived)) {
    await sendActionNotice(transport, result, {
      maskClient, llmReview, listName, pacer, reviewQueue,
    });
  }
  if (!result || !result.deferred || !reviewQueue || !isCurrent()) return result;
  const wid = selfWid(transport);
  if (!wid) {
    log.error('guided review has no self chat', { chatId });
    return result;
  }
  try {
    const delivered = await deliverGuidedReview({
      result: { ...result, listName },
      maskClient,
      llmReview,
      env: process.env,
      queue: reviewQueue,
      exclusive: (fn) => pacer.exclusive(fn),
      forward: () => msg.forward(wid),
      sendText: (text) => transport.sendText(wid, text),
      sendPoll: (name, options) =>
        transport.sendPoll(wid, { name, options, allowMultipleAnswers: false }),
    });
    if (delivered && delivered.pollId && result.cooldownEligible && isCurrent()) {
      recordChatLlmReviewSuccess(chatId, { store: llmCooldownStore });
    }
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

function attachHandlers(clientOrTransport, deps) {
  const transport = ensureTransport(clientOrTransport);
  const inFlight = new Map();
  let setupInFlight = false;
  async function handleCurrent(msg, options) {
    const id = incomingMessageId(msg);
    const revision = {};
    if (id) inFlight.set(id, revision);
    const isCurrent = () => !id || inFlight.get(id) === revision;
    try {
      return await handleWaMessage(msg, { transport, ...deps, ...options, isCurrent });
    } finally {
      if (id && isCurrent()) inFlight.delete(id);
    }
  }

  transport.on('qr', (qr) => {
    log.info('scan QR to link WhatsApp Web');
    qrcode.generate(qr, { small: true });
  });

  transport.on('authenticated', () => {
    log.ok('WhatsApp session authenticated');
  });

  transport.on('auth_failure', (m) => {
    log.error('auth failure', m);
  });

  transport.on('ready', () => {
    log.ok('WhatsApp client ready');
    if (setupInFlight || !deps.operator || !deps.operator.needsSetup()) return;
    setupInFlight = true;
    sendSetupPoll(transport, deps.operator)
      .catch((err) => {
        log.error('operator setup failed', { error: err.message });
      })
      .finally(() => {
        setupInFlight = false;
      });
  });

  transport.on('message', async (msg) => {
    try {
      await handleCurrent(msg);
    } catch (err) {
      log.error('message handler failed', { error: err.message });
    }
  });

  transport.on('message_edit', async (msg, newBody, prevBody) => {
    try {
      if (typeof newBody === 'string') {
        if (newBody === prevBody) return;
        if (msg) msg.body = newBody;
      }
      if (msg && msg.fromMe) {
        await recordOwnMessage(msg, {
          ...deps,
          transport,
          editedFrom: typeof prevBody === 'string' ? prevBody : null,
        });
        return;
      }
      const id = incomingMessageId(msg);
      const invalidated = deps.reviewQueue
        ? invalidatePendingGuidedReview(deps.reviewQueue, id)
        : 0;
      const voided = deps.reviewQueue
        ? deps.reviewQueue.voidByMessageId(id, 'edited')
        : [];
      await handleCurrent(msg, {
        bypassLlmCooldown: voided.length + invalidated > 0 || inFlight.has(id),
        editedFrom: typeof prevBody === 'string' ? prevBody : null,
      });
    } catch (err) {
      log.error('message edit handler failed', { error: err.message });
    }
  });

  transport.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      await recordOwnMessage(msg, { ...deps, transport });
      if (deps.operator) await handleSelfMessage(msg, { transport, ...deps });
    } catch (err) {
      log.error('self chat handler failed', { error: err.message });
    }
  });

  transport.on('vote_update', async (vote) => {
    try {
      if (!deps.operator || !deps.reviewQueue) return;
      const route = routeVote(vote, {
        operator: deps.operator,
        queue: deps.reviewQueue,
      });
      if (route.kind === 'setup') {
        await confirmOperatorMode(transport, deps.operator, route.mode);
      } else if (route.kind === 'already') {
        const wid = selfWid(transport);
        if (wid) await transport.sendText(wid, '已經處理咗。');
      } else if (route.kind === 'voided') {
        const wid = selfWid(transport);
        if (wid) await transport.sendText(wid, VOIDED_POLL_TEXT);
      } else if (route.kind === 'review') {
        await confirmReviewChoice(
          transport,
          deps.reviewQueue,
          deps.pacer,
          route.choice,
          route.pollId,
          { botContactNames: deps.botContactNames },
        );
      } else if (route.kind === 'unblock') {
        await confirmUnblockChoice(
          transport,
          deps.reviewQueue,
          deps.pacer,
          route.choice,
          route.pollId,
          { botContactNames: deps.botContactNames },
        );
      }
    } catch (err) {
      log.error('vote handler failed', { error: err.message });
    }
  });

  transport.on('disconnected', (reason) => {
    log.warn('disconnected', { reason });
  });
}

async function main() {
  const maskClient = createMaskClient();
  const llmReview = createLlmReviewConfig();
  const contextOn = contextLlmEnabled();
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
  const botContactNames = createBotContactNames({
    filePath: defaultBotContactNamesPath(process.env),
  });
  const transport = createWhatsAppTransport({ env: process.env, authPath: AUTH_PATH });

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
    waTransport: transport.name,
    maskWorker: maskClient.baseURL,
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

  attachHandlers(transport, {
    maskClient,
    llmReview,
    pacer,
    threadContext,
    recentContext,
    operator,
    reviewQueue,
    llmCooldownStore,
    botContactNames,
  });
  await transport.initialize();
}

module.exports = {
  AUTH_PATH,
  createMaskClient,
  createWhatsAppClient,
  createWhatsAppTransport,
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
