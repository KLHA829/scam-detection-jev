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
const { applyBlockPolicy } = require('./block-policy');
const { appendBlockRecord, defaultBlockLogPath } = require('./block-log');
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
  if (decision.action === 'archive' && shouldSuppress(body)) {
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

  decision = applyBlockPolicy(decision, {
    savedContact,
    scoreResult,
    heuristic,
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

  if (typeof deps.exclusive === 'function') {
    await deps.exclusive(applyWhatsAppAction);
  } else {
    await applyWhatsAppAction();
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

module.exports = {
  withChatLock,
  processIncomingMessage,
};
