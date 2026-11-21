'use strict';

const { shouldIgnoreMessage } = require('./filters');
const { matchObviousScam } = require('./link-rules');
const { decideIncomingAction } = require('./decide-incoming');
const { loadRubric } = require('./score-message');
const { analyzeScamIntent } = require('./scam-intent');
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
  maskMessagesForLlm,
} = require('./context-llm');
const { applyBlockPolicy } = require('./block-policy');
const { appendBlockRecord, defaultBlockLogPath } = require('./block-log');
const { recentReviewBodies } = require('./review-guide');
const {
  isChatLlmCooldownActive,
  recordChatLlmReviewSuccess,
} = require('./llm-review-cooldown');
const log = require('./log');

const inflight = new Map();

function primaryScoreResult(rubric, reason) {
  const thresholds = (rubric && rubric.thresholds) || { archive: 42, safe: 18, block: 80 };
  return {
    score: 0,
    raw: 0,
    bonus: 0,
    breakdown: [],
    label: 'unknown',
    ok: true,
    reason,
    thresholds,
    scorer: 'none',
  };
}

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
    chatId,
    from: input.from,
  });
  if (ignored.ignore) {
    log.info(`skip message (${ignored.reason})`, { chatId });
    return { ignored: true, reason: ignored.reason };
  }

  return withChatLock(chatId, () =>
    runIncomingMessage(input, deps, { body, chatId, savedContact, messageId }),
  );
}

async function runIncomingMessage(input, deps = {}, { body, chatId, savedContact, messageId }) {
  const env = deps.env || process.env;
  const { resolveNumber, archiveChat, maskClient, rubric: rubricIn } = deps;
  const rubric = rubricIn || loadRubric(undefined, env);
  const resolved = resolveNumber
    ? await resolveNumber()
    : { digits: null, unresolvedLid: false, source: 'wid' };

  const formattedNumber = resolved.unresolvedLid ? null : resolved.digits || null;
  if (resolved.unresolvedLid) {
    log.warn('unresolved @lid; LID digits are not a phone number', { chatId });
  }

  const thread = deps.threadContext;
  const priorTurns = thread ? thread.prior(chatId) : [];
  const scoredText = String(body || '').trim();
  const currentHeuristic = matchObviousScam(body, env);
  const fastHeuristic =
    Boolean(currentHeuristic.hit) &&
    deps.operatorMode !== 'guided';

  const scoreSource = fastHeuristic ? 'heuristic' : 'llm_primary';
  const scoreResult = primaryScoreResult(
    rubric,
    fastHeuristic ? 'heuristic_first' : 'llm_primary',
  );
  const picked = { scoreResult, text: scoredText, source: scoreSource };

  if (thread) thread.push(chatId, body);
  const contextOn =
    (deps.contextLlm && deps.contextLlm.enabled != null
      ? Boolean(deps.contextLlm.enabled)
      : contextLlmEnabled(env));
  if (contextOn && deps.recentContext) deps.recentContext.push(chatId, body);

  const heuristic = fastHeuristic ? currentHeuristic : matchObviousScam(scoredText, env);
  const llmOpts = deps.llmReview || null;
  const llmOn =
    llmOpts && llmOpts.enabled != null
      ? Boolean(llmOpts.enabled)
      : llmReviewEnabled(env);
  const intent = !contextOn && llmOn ? analyzeScamIntent(scoredText) : null;

  log.scan('message inbound', {
    chatId,
    scoreSource: picked.source,
    heuristic: heuristic.hit ? heuristic.id : null,
    digits: formattedNumber,
    savedContact: Boolean(savedContact),
    llmOn,
    contextOn,
  });

  let decision = decideIncomingAction(
    scoreResult,
    formattedNumber,
    savedContact,
    heuristic,
  );

  let llmTrigger;
  let llmReview = null;
  let redacted = null;
  const contextHardSkip = Boolean(heuristic && heuristic.hit);
  const llmCooldownStore = deps.llmCooldownStore;

  if (contextOn) {
    if (contextHardSkip) {
      llmTrigger = {
        trigger: false,
        reasons: [],
        skipped: 'hard_archive',
      };
    } else if (
      isChatLlmCooldownActive(chatId, env, { store: llmCooldownStore })
    ) {
      llmTrigger = {
        trigger: false,
        reasons: [],
        skipped: 'cooldown',
      };
      log.info('context llm skipped', { chatId, skipped: 'cooldown' });
    } else {
      const opening = deps.recentContext
        ? deps.recentContext.recent(chatId)
        : [String(body || '').trim()].filter(Boolean);
      const reviewed = await reviewOpeningMessages({
        messages: opening,
        maskClient,
        llmOptions: { ...(llmOpts || {}), ...(deps.contextLlm || {}), enabled: true },
        env,
      });
      llmTrigger = reviewed.trigger;
      llmReview = reviewed.llmReview;
      redacted = reviewed.redacted;
      if (llmTrigger.trigger && llmReview && llmReview.ok === true) {
        recordChatLlmReviewSuccess(chatId, { store: llmCooldownStore });
      }
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
        heuristic: currentHeuristic,
        env,
        rubric,
      });
    }
  } else {
    llmTrigger = shouldTriggerLlmReview({
      heuristic,
      formattedNumber,
      savedContact,
      decision,
      env,
      enabled: llmOn,
      intent,
    });

    if (
      llmTrigger.trigger &&
      isChatLlmCooldownActive(chatId, env, { store: llmCooldownStore })
    ) {
      llmTrigger = {
        trigger: false,
        reasons: llmTrigger.reasons,
        skipped: 'cooldown',
      };
      log.info('llm review skipped', { chatId, skipped: 'cooldown' });
    }

    if (llmTrigger.trigger) {
      let maskedText = null;
      const source = String(scoredText || '');
      if (!maskClient || typeof maskClient.maskMessages !== 'function') {
        llmTrigger = {
          trigger: false,
          reasons: llmTrigger.reasons,
          skipped: 'mask_unavailable',
        };
        log.info('llm review skipped', { chatId, skipped: 'mask_unavailable' });
      } else {
        try {
          const maskResult = await maskClient.maskMessages([source]);
          maskedText = maskMessagesForLlm([source], maskResult)[0];
        } catch (err) {
          llmTrigger = {
            trigger: false,
            reasons: llmTrigger.reasons,
            skipped: 'mask_failed',
          };
          log.info('llm review skipped', {
            chatId,
            skipped: 'mask_failed',
            error: err && err.message ? err.message : String(err),
          });
        }
      }
      if (maskedText == null || !llmTrigger.trigger) {
        llmReview = null;
      } else {
        redacted = maskedText;
        log.scan('llm review (masked only)', {
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
        if (llmReview && llmReview.ok === true) {
          recordChatLlmReviewSuccess(chatId, { store: llmCooldownStore });
        }
      }
    }
  }

  decision = applyBlockPolicy(decision, {
    savedContact,
    scoreResult,
    heuristic: currentHeuristic,
    env,
    rubric,
  });
  if (deps.holdBlock && decision.action === 'block') {
    decision = {
      action: 'archive',
      archiveReason: decision.archiveReason,
      heldBlock: true,
    };
  }

  let actionOutcome = null;
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
        errors: [
          ...((blockResult && blockResult.errors) || []),
          ...(archiveError
            ? [`archive:${archiveError.message ? archiveError.message : String(archiveError)}`]
            : []),
        ],
      };
      try {
        if (typeof deps.recordBlock === 'function') {
          await deps.recordBlock(record);
        } else {
          appendBlockRecord(record, defaultBlockLogPath(env));
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        record.errors.push(`log:${message}`);
        log.error('block log failed', { chatId, error: message });
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

    actionOutcome = {
      blocked: Boolean(blockResult && blockResult.blocked),
      archived,
    };
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
    intent,
    formattedNumber,
    resolved,
    llmTrigger,
    llmReview,
    redacted,
    deferred: Boolean(defer),
    reviewMessages:
      decision.action === 'block' || decision.action === 'archive'
        ? recentReviewBodies(priorTurns, body)
        : [],
    blocked: Boolean(actionOutcome && actionOutcome.blocked),
    archived: Boolean(actionOutcome && actionOutcome.archived),
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
