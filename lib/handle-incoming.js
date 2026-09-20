'use strict';

const { shouldIgnoreMessage } = require('./filters');
const { matchObviousScam } = require('./heuristics');
const { decideIncomingAction } = require('./decide-incoming');
const { scoreMessage } = require('./score-message');
const { cacheKeyForMessage } = require('./cache');
const { scoreLocalClassifier } = require('./local-classifier-client');
const { applyClassifierPolicy } = require('./classifier-policy');
const log = require('./log');

let matchRagScam = null;
try {
  ({ matchRagScam } = require('./rag'));
} catch {
  matchRagScam = null;
}

const inflight = new Map();

function withChatLock(chatId, fn) {
  const key = chatId || '_';
  const prev = inflight.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  inflight.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function processIncomingMessage(input, deps) {
  const {
    fromMe,
    isGroup,
    type,
    isMe,
    pushName,
    contactName,
    body,
    chatId,
    savedContact,
    messageId,
  } = input;

  const ignored = shouldIgnoreMessage({
    fromMe,
    isGroup,
    type,
    isMe,
    pushName,
    contactName,
  });
  if (ignored.ignore) {
    log.info(`skip message (${ignored.reason})`, { chatId });
    return { ignored: true, reason: ignored.reason };
  }

  return withChatLock(chatId, () =>
    runScoredMessage(input, deps, { body, chatId, savedContact, messageId }),
  );
}

async function runScoredMessage(input, deps, { body, chatId, savedContact, messageId }) {
  const { resolveNumber, archiveChat, scoreClient, rubric, cache } = deps;
  const env = deps.env || process.env;
  const resolved = resolveNumber
    ? await resolveNumber()
    : { digits: null, unresolvedLid: false, source: 'wid' };

  const formattedNumber = resolved.unresolvedLid ? null : resolved.digits || null;
  if (resolved.unresolvedLid) {
    log.warn('unresolved @lid; skipping foreign-number rule', { chatId });
  }

  const heuristic = matchObviousScam(body, env);
  const ragFn = deps.matchRag || matchRagScam;
  const rag = typeof ragFn === 'function' ? ragFn(body, env) : null;
  const key = cacheKeyForMessage(messageId, body);
  const [scoreResult, classifierRaw] = await Promise.all([
    scoreMessage(body, {
      client: scoreClient,
      rubric,
      cache,
      cacheKey: key,
    }),
    scoreLocalClassifier(body, {
      env,
      fetchImpl: deps.classifierFetch,
      timeoutMs: deps.classifierTimeoutMs,
      url: deps.classifierUrl,
    }),
  ]);
  const classifier = applyClassifierPolicy(body, classifierRaw, env);

  log.scan('message scored', {
    chatId,
    score: scoreResult.score,
    label: scoreResult.label,
    ok: scoreResult.ok,
    bonus: scoreResult.bonus,
    breakdown: scoreResult.breakdown,
    heuristic: heuristic.hit ? heuristic.id : null,
    rag: rag && rag.hit ? rag.id : null,
    classifier: classifier.skipped
      ? classifier.reason
      : {
          hit: classifier.hit,
          prob_scam: classifier.prob_scam,
          ok: classifier.ok,
          combo: classifier.combo || null,
          suppressed: classifier.suppressed || null,
        },
    digits: formattedNumber,
    savedContact: Boolean(savedContact),
  });

  const decision = decideIncomingAction(
    scoreResult,
    formattedNumber,
    savedContact,
    heuristic,
    { classifier, rag },
  );

  if (decision.action === 'archive') {
    if (typeof archiveChat === 'function') {
      await archiveChat(decision.archiveReason);
    }
    log.ok(`archived chat (${decision.archiveReason})`, {
      chatId,
      score: scoreResult.score,
      label: scoreResult.label,
    });
  }

  return {
    ignored: false,
    decision,
    scoreResult,
    heuristic,
    classifier,
    rag,
    formattedNumber,
    resolved,
  };
}

async function startupForeignArchive(chats, { archiveChat, logFn } = {}) {
  const logger = logFn || log;
  let archived = 0;
  for (const chat of chats) {
    if (!chat || chat.savedContact || !chat.nonLocal || chat.unresolvedLid) {
      continue;
    }
    if (typeof archiveChat === 'function') {
      await archiveChat(chat, 'foreign_number');
    }
    archived += 1;
    logger.ok('startup archived unsaved foreign chat', {
      chatId: chat.chatId,
      digits: chat.digits,
    });
  }
  return archived;
}

function pickSidebarOneToOne(chats, limit = 10) {
  return (chats || []).filter((chat) => chat && !chat.isGroup).slice(0, limit);
}

module.exports = {
  withChatLock,
  processIncomingMessage,
  startupForeignArchive,
  pickSidebarOneToOne,
};
