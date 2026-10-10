'use strict';

const { shouldIgnoreMessage } = require('./filters');
const { matchObviousScam } = require('./heuristics');
const { decideIncomingAction } = require('./decide-incoming');
const { scoreMessage, jevlikeMaxChars } = require('./score-message');
const { cacheKeyForMessage } = require('./cache');
const { analyzeScamIntent, shouldSuppress } = require('./scam-intent');
const { redactPii } = require('./redact');
const {
  llmReviewEnabled,
  shouldTriggerLlmReview,
  reviewRedactedMessage,
  mergeLlmDecision,
} = require('./llm-review');
const {
  contextLlmEnabled,
  applyContextLlmDecision,
  reviewOpeningMessages,
} = require('./context-llm');
const { applyBlockPolicy, resolveBlockThreshold } = require('./block-policy');
const {
  contextTurnsFromEnv,
  joinWindow,
  pickContextScore,
} = require('./thread-context');
const { appendBlockRecord, defaultBlockLogPath } = require('./block-log');
const { recentReviewBodies } = require('./review-guide');
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
    log.warn('unresolved @lid; LID digits are not a phone number', { chatId });
  }

  const thread = deps.threadContext;
  const priorTurns = thread ? thread.prior(chatId) : [];
  const single = await scoreMessage(body, {
    client: scoreClient,
    rubric,
    cache,
    cacheKey: cacheKeyForMessage(messageId, body),
    env,
  });

  let windowResult = null;
  let windowText = null;
  const blockAt = resolveBlockThreshold({ env, rubric, scoreResult: single });
  const useWindow =
    thread &&
    contextTurnsFromEnv(env) > 1 &&
    priorTurns.length > 0 &&
    !(single.ok !== false && Number(single.score) >= blockAt);
  if (useWindow) {
    windowText = joinWindow(priorTurns, body, jevlikeMaxChars(rubric, env));
    if (windowText && windowText !== String(body || '').trim()) {
      windowResult = await scoreMessage(windowText, {
        client: scoreClient,
        rubric,
        cache,
        cacheKey: cacheKeyForMessage(`${messageId || ''}#window`, windowText),
        env,
      });
    }
  }

  const picked = pickContextScore({
    single,
    window: windowResult,
    currentText: body,
    windowText,
    env,
    rubric,
  });
  const scoreResult = picked.scoreResult;
  const scoredText = picked.text;
  if (thread) thread.push(chatId, body);
  const contextOn =
    (deps.contextLlm && deps.contextLlm.enabled != null
      ? Boolean(deps.contextLlm.enabled)
      : contextLlmEnabled(env));
  if (contextOn && deps.recentContext) deps.recentContext.push(chatId, body);

  const heuristic = matchObviousScam(scoredText, env);
  const currentHeuristic = matchObviousScam(body, env);
  const rag = optionalMatcher(deps.matchRagScam, scoredText, env);
  const localClassifier = optionalMatcher(deps.matchLocalClassifier, scoredText, env);
  const intent = analyzeScamIntent(scoredText);

  log.scan('message scored', {
    chatId,
    score: scoreResult.score,
    label: scoreResult.label,
    ok: scoreResult.ok,
    bonus: scoreResult.bonus,
    breakdown: scoreResult.breakdown,
    scoreSource: picked.source,
    singleScore: single.score,
    windowScore: windowResult ? windowResult.score : null,
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
  if (decision.action === 'archive' && shouldSuppress(scoredText)) {
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
  const contextHardSkip = Boolean(
    suppressed ||
      (heuristic && heuristic.hit) ||
      (rag && rag.hit) ||
      (localClassifier && localClassifier.hit),
  );

  if (contextOn) {
    if (contextHardSkip) {
      llmTrigger = {
        trigger: false,
        reasons: [],
        skipped: suppressed ? 'suppressed' : 'hard_archive',
      };
    } else {
      const opening = deps.recentContext
        ? deps.recentContext.recent(chatId)
        : [String(body || '').trim()].filter(Boolean);
      const reviewed = await reviewOpeningMessages({
        messages: opening,
        scoreClient,
        llmOptions: { ...(llmOpts || {}), ...(deps.contextLlm || {}), enabled: true },
        env,
      });
      llmTrigger = reviewed.trigger;
      llmReview = reviewed.llmReview;
      redacted = reviewed.redacted;
      if (llmTrigger.trigger) {
        log.scan('context llm', {
          chatId,
          messages: opening.length,
          action: llmReview && llmReview.action,
          ok: llmReview && llmReview.ok,
          reason: llmReview && llmReview.reason,
        });
      } else if (llmTrigger.skipped) {
        log.info('context llm skipped', { chatId, skipped: llmTrigger.skipped });
      }
      decision = applyContextLlmDecision(decision, llmReview, {
        savedContact,
        scoreResult: single,
        heuristic: currentHeuristic,
        env,
        rubric,
      });
    }
  } else llmTrigger = shouldTriggerLlmReview({
    scoreResult,
    heuristic,
    rag,
    localClassifier,
    text: scoredText,
    formattedNumber,
    savedContact,
    decision,
    env,
    enabled: llmOn,
    intent,
  });

  if (!contextOn && llmTrigger.trigger) {
    const redaction = redactPii(scoredText);
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

  decision = applyBlockPolicy(decision, {
    savedContact,
    scoreResult: single,
    heuristic: currentHeuristic,
    env,
    rubric,
  });

  const applyWhatsAppAction = async () => {
  if (decision.action === 'block' || decision.action === 'archive') {
    let blockResult = null;
    if (decision.action === 'block' && typeof deps.blockContact === 'function') {
      try {
        blockResult = await deps.blockContact({
          contactName: decision.contactName,
          digits: formattedNumber,
          blockReason: decision.blockReason,
          archiveReason: decision.archiveReason,
          score: scoreResult.score,
          chatId,
        });
      } catch (err) {
        blockResult = {
          renamed: false,
          blocked: false,
          muted: false,
          errors: [`block:${err && err.message ? err.message : String(err)}`],
        };
        log.error('block contact failed', { chatId, error: err.message });
      }
    }

    let archived = false;
    let archiveError = null;
    if (typeof archiveChat === 'function') {
      try {
        if (typeof deps.pauseAction === 'function') await deps.pauseAction();
        await archiveChat(decision.archiveReason);
        archived = true;
      } catch (err) {
        archiveError = err;
        log.error('archive failed', { chatId, error: err.message });
      }
    }

    if (decision.action === 'block') {
      const record = {
        at: new Date().toISOString(),
        chatId,
        digits: formattedNumber,
        pushName: input.pushName || input.contactName || null,
        score: scoreResult.score,
        label: scoreResult.label,
        archiveReason: decision.archiveReason,
        blockReason: decision.blockReason,
        heuristicId: decision.heuristicId || null,
        contactName: decision.contactName,
        renamed: Boolean(blockResult && blockResult.renamed),
        blocked: Boolean(blockResult && blockResult.blocked),
        muted: Boolean(blockResult && blockResult.muted),
        archived,
        errors: (blockResult && blockResult.errors) || [],
      };
      if (typeof deps.recordBlock === 'function') {
        await deps.recordBlock(record);
      } else {
        appendBlockRecord(record, defaultBlockLogPath(env));
      }
      const blockLog = record.blocked ? log.ok : log.warn;
      blockLog(
        record.blocked
          ? `blocked contact (${decision.blockReason})`
          : `block incomplete (${decision.blockReason})`,
        {
          chatId,
          digits: formattedNumber,
          score: scoreResult.score,
          contactName: decision.contactName,
          renamed: record.renamed,
          blocked: record.blocked,
          muted: record.muted,
        },
      );
    } else if (archived) {
      log.ok(`archived chat (${decision.archiveReason})`, {
        chatId,
        score: scoreResult.score,
        label: scoreResult.label,
      });
    }

    if (archiveError) throw archiveError;
  }
  };

  const guided = deps.operatorMode === 'guided';
  const defer =
    guided && (decision.action === 'block' || decision.action === 'archive');
  if (!defer) {
    if (typeof deps.exclusive === 'function') {
      await deps.exclusive(applyWhatsAppAction);
    } else {
      await applyWhatsAppAction();
    }
  }

  return {
    ignored: false,
    decision,
    scoreResult,
    scoreSource: picked.source,
    scoredText,
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
    deferred: Boolean(defer),
    reviewMessages: defer ? recentReviewBodies(priorTurns, body) : [],
    savedContact: Boolean(savedContact),
    pushName: input.pushName || input.contactName || null,
    body: String(body || ''),
    chatId,
    messageId: messageId || null,
  };
}

module.exports = {
  withChatLock,
  processIncomingMessage,
};
