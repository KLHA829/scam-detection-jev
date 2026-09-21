'use strict';

const { shouldIgnoreMessage } = require('./filters');
const { matchObviousScam } = require('./heuristics');
const { decideIncomingAction } = require('./decide-incoming');
const { scoreMessage } = require('./score-message');
const { cacheKeyForMessage } = require('./cache');
const { analyzeScamIntent, shouldSuppress } = require('./scam-intent');
const { redactPii } = require('./redact');
const {
  llmReviewEnabled,
  shouldTriggerLlmReview,
  reviewRedactedMessage,
  mergeLlmDecision,
} = require('./llm-review');
const log = require('./log');

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

function optionalMatcher(fn, text, env) {
  if (typeof fn !== 'function') return { hit: false, id: null };
  try {
    return fn(text, env) || { hit: false, id: null };
  } catch {
    return { hit: false, id: null, error: 'matcher_error' };
  }
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

async function runScoredMessage(input, deps = {}, { body, chatId, savedContact, messageId }) {
  const env = deps.env || process.env;
  const { resolveNumber, archiveChat, scoreClient, rubric, cache } = deps;
  const resolved = resolveNumber
    ? await resolveNumber()
    : { digits: null, unresolvedLid: false, source: 'wid' };

  const formattedNumber = resolved.unresolvedLid ? null : resolved.digits || null;
  if (resolved.unresolvedLid) {
    log.warn('unresolved @lid; skipping foreign-number rule', { chatId });
  }

  const heuristic = matchObviousScam(body, env);
  const rag = optionalMatcher(deps.matchRagScam, body, env);
  const localClassifier = optionalMatcher(deps.matchLocalClassifier, body, env);
  const intent = analyzeScamIntent(body);

  const key = cacheKeyForMessage(messageId, body);
  const scoreResult = await scoreMessage(body, {
    client: scoreClient,
    rubric,
    cache,
    cacheKey: key,
    env,
  });

  log.scan('message scored', {
    chatId,
    score: scoreResult.score,
    label: scoreResult.label,
    ok: scoreResult.ok,
    bonus: scoreResult.bonus,
    breakdown: scoreResult.breakdown,
    heuristic: heuristic.hit ? heuristic.id : null,
    rag: rag.hit ? rag.id : null,
    digits: formattedNumber,
    savedContact: Boolean(savedContact),
  });

  let decision = decideIncomingAction(
    scoreResult,
    formattedNumber,
    savedContact,
    heuristic,
    rag,
    localClassifier,
  );

  let suppressed = false;
  if (
    decision.action === 'archive' &&
    decision.archiveReason !== 'foreign_number' &&
    shouldSuppress(body)
  ) {
    suppressed = true;
    log.info('suppress warning/self-otp without solicitation', {
      chatId,
      archiveReason: decision.archiveReason,
      signals: intent.signals,
    });
    decision = {
      action: 'ignore',
      archiveReason: null,
      suppressed: true,
      suppressReason: 'warning_without_solicitation',
    };
  }

  let llmTrigger = { trigger: false, reasons: [], skipped: 'not_run' };
  let llmReview = null;
  let redacted = null;
  const llmOpts = deps.llmReview || null;
  const llmOn =
    llmOpts && llmOpts.enabled != null
      ? Boolean(llmOpts.enabled)
      : llmReviewEnabled(env);

  llmTrigger = shouldTriggerLlmReview({
    scoreResult,
    heuristic,
    rag,
    localClassifier,
    text: body,
    formattedNumber,
    savedContact,
    decision,
    env,
    enabled: llmOn,
    intent,
  });

  if (llmTrigger.trigger) {
    const redaction = redactPii(body);
    redacted = redaction.redacted;
    log.scan('llm review (redacted only)', {
      chatId,
      reasons: llmTrigger.reasons,
      redacted,
    });
    llmReview = await reviewRedactedMessage(redacted, {
      ...llmOpts,
      enabled: true,
      env,
    });
    const prior = decision;
    decision = mergeLlmDecision(decision, llmReview, {
      env,
      merge: llmOpts && llmOpts.merge,
    });
    if (decision.released) {
      log.scan('llm review release', {
        chatId,
        label: llmReview.label,
        reason: llmReview.reason,
        priorArchiveReason: prior.archiveReason,
      });
    } else if (
      decision.action === 'archive' &&
      (prior.action !== 'archive' ||
        prior.archiveReason !== decision.archiveReason)
    ) {
      log.scan('llm review archive', {
        chatId,
        label: llmReview.label,
        reason: llmReview.reason,
      });
    } else if (decision.action === 'archive') {
      log.scan('llm review keep archive', {
        chatId,
        label: llmReview && llmReview.label,
        ok: llmReview && llmReview.ok,
        reason: llmReview && llmReview.reason,
        archiveReason: decision.archiveReason,
      });
    } else {
      log.scan('llm review no archive', {
        chatId,
        label: llmReview && llmReview.label,
        ok: llmReview && llmReview.ok,
        reason: llmReview && llmReview.reason,
      });
    }
  }

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
    rag,
    localClassifier,
    intent,
    formattedNumber,
    resolved,
    suppressed,
    llmTrigger,
    llmReview,
    redacted,
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
