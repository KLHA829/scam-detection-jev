'use strict';

const { shouldIgnoreMessage } = require('./filters');
const { isDirectArchiveHit, matchObviousScam } = require('./link-rules');
const { decideIncomingAction } = require('./decide-incoming');
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
  clearsPitchLabel,
  reviewOpeningMessages,
  maskMessagesForLlm,
} = require('./context-llm');
const { applyBlockPolicy, isUnsavedContact, SUSPICIOUS_PITCH_CONTACT_NAME } = require('./block-policy');
const { appendBlockRecord, defaultBlockLogPath } = require('./block-log');
const { recentReviewBodies } = require('./review-guide');
const {
  isChatLlmCooldownActive,
  recordChatLlmReviewSuccess,
} = require('./llm-review-cooldown');
const log = require('./log');

const inflight = new Map();

function primaryScoreResult(reason) {
  return {
    score: 0,
    raw: 0,
    bonus: 0,
    breakdown: [],
    label: 'unknown',
    ok: true,
    reason,
    scorer: 'none',
  };
}

function withChatLock(chatId, fn) {
  const key = chatId || '_';
  const prev = inflight.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = () => {
    if (inflight.get(key) === settled) inflight.delete(key);
  };
  const settled = next.then(cleanup, cleanup);
  inflight.set(key, settled);
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

function isFirstContact(savedContact, recentContext, chatId, turns) {
  if (savedContact !== false) return false;
  return recentContext ? recentContext.firstContact(chatId) : turns.length === 1;
}

function recordOutgoingMessage({ type, isGroup, chatId, body, messageId, editedFrom }, deps = {}) {
  if (!deps.recentContext) return false;
  if (shouldIgnoreMessage({ type, isGroup, chatId }).ignore) return false;
  deps.recentContext.push(chatId, body, { messageId, replaces: editedFrom, fromMe: true });
  return true;
}

async function runIncomingMessage(input, deps = {}, { body, chatId, savedContact, messageId }) {
  const env = deps.env || process.env;
  const { resolveNumber, archiveChat, maskClient, isCurrent = () => true } = deps;
  const resolved = resolveNumber
    ? await resolveNumber()
    : { digits: null, unresolvedLid: false, source: 'wid' };
  if (!isCurrent()) return null;

  const formattedNumber = resolved.unresolvedLid ? null : resolved.digits || null;
  if (resolved.unresolvedLid) {
    log.warn('unresolved @lid; LID digits are not a phone number', { chatId });
  }

  const thread = deps.threadContext;
  if (thread) thread.remove(chatId, deps.editedFrom, { messageId });
  const priorTurns = thread ? thread.prior(chatId) : [];
  const scoredText = String(body || '').trim();
  const currentHeuristic = matchObviousScam(body, env);
  const fastHeuristic =
    isDirectArchiveHit(currentHeuristic) &&
    deps.operatorMode !== 'guided';

  const scoreSource = fastHeuristic ? 'heuristic' : 'llm_primary';
  const scoreResult = primaryScoreResult(fastHeuristic ? 'heuristic_first' : 'llm_primary');
  const picked = { scoreResult, text: scoredText, source: scoreSource };

  if (thread) thread.push(chatId, body, { messageId });
  const contextOn =
    (deps.contextLlm && deps.contextLlm.enabled != null
      ? Boolean(deps.contextLlm.enabled)
      : contextLlmEnabled(env));
  if (contextOn && deps.recentContext) {
    deps.recentContext.push(chatId, body, { messageId, replaces: deps.editedFrom });
  }

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
  let clearLabel = false;
  let redacted = null;
  const llmCooldownStore = deps.llmCooldownStore;
  const llmCooldownActive = () =>
    !deps.bypassLlmCooldown && isChatLlmCooldownActive(chatId, env, { store: llmCooldownStore });

  if (contextOn && llmOn) {
    if (decision.action === 'archive') {
      llmTrigger = {
        trigger: false,
        reasons: [],
        skipped: 'hard_archive',
      };
    } else if (llmCooldownActive()) {
      llmTrigger = {
        trigger: false,
        reasons: [],
        skipped: 'cooldown',
      };
      log.info('context llm skipped', { chatId, skipped: 'cooldown' });
    } else {
      const turns = deps.recentContext
        ? deps.recentContext.recent(chatId)
        : [{ fromMe: false, body }];
      const firstContact = isFirstContact(savedContact, deps.recentContext, chatId, turns);
      const reviewed = await reviewOpeningMessages({
        turns,
        maskClient,
        llmOptions: { ...(llmOpts || {}), ...(deps.contextLlm || {}), enabled: true },
        env,
      });
      llmTrigger = reviewed.trigger;
      llmReview = reviewed.llmReview;
      redacted = reviewed.redacted;
      if (llmTrigger.trigger) {
        log.scan('context llm', {
          chatId,
          messages: turns.length,
          action: llmReview && llmReview.action,
          ok: llmReview && llmReview.ok,
          reason: llmReview && llmReview.reason,
        });
      } else if (llmTrigger.skipped) {
        log.info('context llm skipped', { chatId, skipped: llmTrigger.skipped });
      }
      decision = applyContextLlmDecision(decision, llmReview, {
        savedContact,
        firstContact,
        heuristic: currentHeuristic,
        env,
      });
      clearLabel = decision.action === 'ignore' && clearsPitchLabel(llmReview, { savedContact, env });
    }
  } else {
    llmTrigger = shouldTriggerLlmReview({
      heuristic,
      decision,
      env,
      enabled: llmOn,
    });

    if (llmTrigger.trigger && llmCooldownActive()) {
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
      }
    }
  }

  if (!isCurrent()) return null;
  const cooldownEligible =
    llmTrigger.trigger && llmReview?.ok === true && decision.action === 'archive';

  decision = applyBlockPolicy(decision, {
    savedContact,
    scoreResult,
    heuristic: currentHeuristic,
    env,
  });
  if (deps.holdBlock && decision.action === 'block') {
    decision = {
      action: 'archive',
      archiveReason: decision.archiveReason,
      heldBlock: true,
    };
  }

  const writes = decision.action === 'block' || decision.action === 'archive';
  let defer = writes && (savedContact === true || deps.operatorMode === 'guided');
  let actionOutcome = null;
  const applyWhatsAppAction = async () => {
  if (!isCurrent()) return;
  if (decision.action === 'block' || decision.action === 'archive') {
    let blockResult = null;
    if (decision.action === 'block' && typeof deps.blockContact === 'function') {
      try {
        blockResult = await deps.blockContact({
          contactName: decision.contactName,
          digits: formattedNumber,
          blockReason: decision.blockReason,
          archiveReason: decision.archiveReason,
          chatId,
        });
        if (blockResult && blockResult.skipped === 'contact_not_unsaved') {
          decision = { action: 'archive', archiveReason: decision.archiveReason };
        }
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
        let canArchive = true;
        if (typeof deps.refreshContact === 'function') {
          const live = await deps.refreshContact().catch(() => null);
          // A name written by this bot (this block, or an earlier block or pitch label) is not a contact saved by the operator.
          canArchive = isUnsavedContact(live, deps.botContactNames) ||
            (live?.isMyContact === true && blockResult?.renamed === true &&
              live.name === decision.contactName);
          if (!canArchive) {
            savedContact = live?.isMyContact === true ? true : null;
            if (!blockResult?.blocked) {
              decision = { action: 'archive', archiveReason: decision.archiveReason };
              defer = true;
              return;
            }
          }
        }
        if (canArchive) {
          await archiveChat(decision.archiveReason);
          archived = true;
        }
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
        label: scoreResult.label,
        archiveReason: decision.archiveReason,
        blockReason: decision.blockReason,
        heuristicId: decision.heuristicId || null,
        contactName: decision.contactName,
        savedContact: Boolean(savedContact),
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
          contactName: decision.contactName,
          renamed: record.renamed,
          blocked: record.blocked,
          muted: record.muted,
        },
      );
    } else if (archived) {
      log.ok(`archived chat (${decision.archiveReason})`, {
        chatId,
        label: scoreResult.label,
      });
    }

    actionOutcome = {
      blocked: Boolean(blockResult && blockResult.blocked),
      archived,
      renamed: Boolean(blockResult && blockResult.renamed),
    };
  }
  };

  let labelOutcome = null;
  const applyContactLabel = async () => {
    if (!isCurrent()) return;
    try {
      labelOutcome = await deps.labelContact({
        digits: formattedNumber,
        contactName: decision.contactName,
        chatId,
      });
    } catch (err) {
      labelOutcome = { labelled: false, error: err && err.message ? err.message : String(err) };
      log.error('label contact failed', { chatId, error: labelOutcome.error });
    }
    if (labelOutcome && labelOutcome.labelled) {
      log.ok(`labelled contact (${decision.labelReason})`, { chatId, contactName: decision.contactName });
    }
  };
  if (decision.action === 'label' && typeof deps.labelContact === 'function') {
    if (typeof deps.exclusive === 'function') {
      await deps.exclusive(applyContactLabel);
    } else {
      await applyContactLabel();
    }
  }

  let clearOutcome = null;
  const clearContactLabel = async () => {
    if (!isCurrent()) return;
    try {
      clearOutcome = await deps.clearContactLabel({
        digits: formattedNumber,
        contactName: SUSPICIOUS_PITCH_CONTACT_NAME,
        chatId,
      });
    } catch (err) {
      clearOutcome = { cleared: false, error: err && err.message ? err.message : String(err) };
      log.error('clear contact label failed', { chatId, error: clearOutcome.error });
    }
    if (clearOutcome && clearOutcome.cleared) {
      log.ok('cleared contact label (context_llm_no_action)', { chatId });
    }
  };
  const labelledByBot = typeof deps.hasContactLabel === 'function' &&
    deps.hasContactLabel({ digits: formattedNumber }) === true;
  if (clearLabel && labelledByBot && typeof deps.clearContactLabel === 'function') {
    if (typeof deps.exclusive === 'function') {
      await deps.exclusive(clearContactLabel);
    } else {
      await clearContactLabel();
    }
  }

  if (writes && !defer) {
    if (typeof deps.exclusive === 'function') {
      await deps.exclusive(applyWhatsAppAction);
    } else {
      await applyWhatsAppAction();
    }
  }
  if (cooldownEligible && ((defer && isCurrent()) || actionOutcome?.archived)) {
    recordChatLlmReviewSuccess(chatId, { store: llmCooldownStore });
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
    renamed: Boolean(actionOutcome && actionOutcome.renamed),
    labelled: Boolean(labelOutcome && labelOutcome.labelled),
    labelCleared: Boolean(clearOutcome && clearOutcome.cleared),
    savedContact: savedContact === null ? null : Boolean(savedContact),
    pushName: input.pushName || input.contactName || null,
    body: String(body || ''),
    chatId,
    messageId: messageId || null,
  };
}

module.exports = {
  get inflightSize() { return inflight.size; },
  withChatLock,
  processIncomingMessage,
  recordOutgoingMessage,
};
