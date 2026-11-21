'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 500;

function defaultReviewQueuePath(env = process.env) {
  if (env && env.REVIEW_QUEUE_PATH) return env.REVIEW_QUEUE_PATH;
  return path.join(process.cwd(), 'review-queue.json');
}

function readQueue(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
      return { items: {} };
    }
    return { items: raw.items };
  } catch {
    return { items: {} };
  }
}

function writeQueue(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
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

function createReviewQueue({ filePath } = {}) {
  const pathName = filePath || defaultReviewQueuePath();
  let data = readQueue(pathName);
  const pending = new Set();

  function save() {
    data = { items: trimItems(data.items) };
    writeQueue(pathName, data);
  }

  return {
    path: pathName,
    beginDelivery(messageId) {
      const record = { messageId, resolved: false };
      pending.add(record);
      return record;
    },
    endDelivery(record) {
      pending.delete(record);
    },
    get(pollId) {
      if (!pollId) return null;
      return data.items[pollId] || null;
    },
    findOpenByMessageId(messageId) {
      if (!messageId) return null;
      return (
        [...Object.values(data.items), ...pending].find(
          (item) => item && !item.resolved && item.messageId === messageId,
        ) || null
      );
    },
    add(record) {
      if (!record || !record.pollId) throw new Error('review poll id required');
      data.items[record.pollId] = record;
      save();
      return record;
    },
    consume(pollId) {
      const item = data.items[pollId];
      if (!item || item.resolved) return null;
      item.resolved = true;
      item.resolvedAt = new Date().toISOString();
      save();
      return item;
    },
    voidByMessageId(messageId, reason) {
      if (!messageId) return [];
      const voided = [...Object.values(data.items), ...pending].filter(
        (item) => item && !item.resolved && item.kind !== 'unblock' && item.messageId === messageId,
      );
      if (voided.length === 0) return [];
      const at = new Date().toISOString();
      for (const item of voided) {
        item.resolved = true;
        item.resolvedAt = at;
        item.voidReason = reason;
      }
      save();
      return voided;
    },
    release(pollId) {
      const item = data.items[pollId];
      if (!item) return null;
      item.resolved = false;
      delete item.resolvedAt;
      save();
      return item;
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
