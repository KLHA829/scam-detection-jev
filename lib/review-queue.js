// @ts-check
'use strict';

const path = require('path');
const { readJsonFile, writeJsonFileAtomic } = require('./json-store');

const MAX_ITEMS = 500;

function defaultReviewQueuePath(env = process.env) {
  if (env && env.REVIEW_QUEUE_PATH) return env.REVIEW_QUEUE_PATH;
  return path.join(process.cwd(), 'review-queue.json');
}

function readQueue(filePath) {
  const res = readJsonFile(filePath);
  if (!res.ok) {
    return { items: {}, transientError: Boolean(res.transient) };
  }
  const raw = res.data;
  if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)) {
    return { items: {}, transientError: false };
  }
  return { items: raw.items, transientError: false };
}

function writeQueue(filePath, data) {
  writeJsonFileAtomic(filePath, data);
}

function trimItems(items) {
  const entries = Object.entries(items);
  if (entries.length <= MAX_ITEMS) return items;
  const resolved = entries
    .filter(([, item]) => item && item.resolved)
    .sort((a, b) => String(a[1].resolvedAt || '').localeCompare(String(b[1].resolvedAt || '')));
  const next = { ...items };
  const overflow = entries.length - MAX_ITEMS;
  for (let i = 0; i < overflow && i < resolved.length; i += 1) {
    delete next[resolved[i][0]];
  }
  return next;
}

/**
 * @param {{ filePath?: string | null }} [options]
 */
function createReviewQueue({ filePath = null } = {}) {
  const pathName = filePath || defaultReviewQueuePath();
  const initial = readQueue(pathName);
  let data = { items: initial.items };
  let diskReadFailed = initial.transientError;
  const pendingVoids = new Set();
  const pendingMessageVoids = new Map();
  const voidedInFlightPolls = new Map();
  const consumptions = new WeakMap();

  function save(items = data.items) {
    let merged = items;
    let recoveredDisk = false;
    if (diskReadFailed) {
      const check = readQueue(pathName);
      if (check.transientError) {
        throw new Error('refusing to overwrite review queue after transient read failure');
      }
      const recovered = {};
      for (const [pollId, row] of Object.entries(check.items)) {
        const pendingVoid =
          row && !row.resolved && row.kind !== 'unblock' && row.messageId
            ? pendingMessageVoids.get(row.messageId)
            : null;
        recovered[pollId] = pendingVoid
          ? { ...row, resolved: true, resolvedAt: pendingVoid.at, voidReason: pendingVoid.reason }
          : row;
      }
      merged = { ...recovered, ...items };
      recoveredDisk = true;
    }
    const next = { items: trimItems(merged) };
    writeQueue(pathName, next);
    data = next;
    if (recoveredDisk) {
      diskReadFailed = false;
      pendingMessageVoids.clear();
    }
  }

  return {
    path: pathName,
    get(pollId) {
      if (!pollId) return null;
      return data.items[pollId] || null;
    },
    findOpenByMessageId(messageId) {
      if (!messageId) return null;
      return (
        Object.values(data.items).find(
          (item) => item && !item.resolved && item.messageId === messageId,
        ) || null
      );
    },
    add(record) {
      if (!record || !record.pollId) throw new Error('review poll id required');
      const items = { ...data.items, [record.pollId]: record };
      try {
        save(items);
      } catch (err) {
        // Keep already-sent unblock polls actionable in this process after storage recovers.
        if (record.kind === 'unblock') data.items = items;
        throw err;
      }
      return record;
    },
    consume(pollId) {
      const item = data.items[pollId];
      if (!item || item.resolved || pendingVoids.has(pollId)) return null;
      const consumed = { ...item, resolved: true, resolvedAt: new Date().toISOString() };
      const items = { ...data.items, [pollId]: consumed };
      const previous = [[pollId, item]];
      if (item.kind === 'unblock' && item.chatId) {
        for (const [id, sibling] of Object.entries(items)) {
          if (id !== pollId && sibling && !sibling.resolved &&
              sibling.kind === 'unblock' && sibling.chatId === item.chatId) {
            items[id] = { ...sibling, resolved: true, resolvedAt: consumed.resolvedAt };
            previous.push([id, sibling]);
          }
        }
      }
      save(items);
      consumptions.set(consumed, previous.map(([id, before]) => ({ id, before, after: items[id] })));
      return consumed;
    },
    isPendingVoid(pollId) {
      return pendingVoids.has(pollId);
    },
    voidByMessageId(messageId, reason) {
      if (!messageId) return [];
      if (diskReadFailed) {
        pendingMessageVoids.set(messageId, {
          reason: reason || 'edited',
          at: new Date().toISOString(),
        });
      }
      for (const [pollId, item] of Object.entries(data.items)) {
        if (item && item.resolved && item.kind !== 'unblock' && item.messageId === messageId && consumptions.has(item)) {
          voidedInFlightPolls.set(pollId, reason || 'edited');
        }
      }
      const matches = Object.entries(data.items).filter(
        ([, item]) => item && !item.resolved && item.kind !== 'unblock' && item.messageId === messageId,
      );
      if (matches.length === 0) return [];
      const items = { ...data.items };
      const at = new Date().toISOString();
      const voided = matches.map(([pollId, item]) => {
        const next = { ...item, resolved: true, resolvedAt: at, voidReason: reason };
        items[pollId] = next;
        return next;
      });
      try {
        save(items);
      } catch (err) {
        // Refuse stale votes even if storage recovers before the edit is retried.
        for (const [pollId] of matches) pendingVoids.add(pollId);
        throw err;
      }
      for (const [pollId] of matches) pendingVoids.delete(pollId);
      return voided;
    },
    release(pollId) {
      const item = data.items[pollId];
      if (!item) return null;
      if (pendingVoids.has(pollId) || voidedInFlightPolls.has(pollId)) {
        const voidReason = voidedInFlightPolls.get(pollId) || item.voidReason || 'edited';
        const items = {
          ...data.items,
          [pollId]: {
            ...item,
            resolved: true,
            resolvedAt: item.resolvedAt || new Date().toISOString(),
            voidReason,
          },
        };
        try {
          save(items);
        } catch {}
        consumptions.delete(item);
        voidedInFlightPolls.delete(pollId);
        return null;
      }
      const items = { ...data.items };
      const previous = consumptions.get(item);
      if (previous) {
        for (const { id, before, after } of previous) {
          if (items[id] === after) items[id] = { ...before, resolved: false };
        }
      } else {
        items[pollId] = { ...item, resolved: false };
        delete items[pollId].resolvedAt;
      }
      try {
        save(items);
      } catch (err) {
        data.items = items;
        throw err;
      }
      consumptions.delete(item);
      return data.items[pollId];
    },
    findOpenUnblock() {
      return Object.entries(data.items)
        .filter(([, item]) => item && !item.resolved && item.kind === 'unblock')
        .map(([pollId, item]) => ({ pollId, ...item }))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
  };
}

module.exports = {
  defaultReviewQueuePath,
  createReviewQueue,
};
