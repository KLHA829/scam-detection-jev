// @ts-check
'use strict';

const path = require('path');
const log = require('./log');
const { readJsonFile, writeJsonFileAtomic } = require('./json-store');

const MAX_ENTRIES = 5000;

function defaultUserRestoredChatsPath(env = process.env) {
  if (env && env.USER_RESTORED_CHATS_PATH) return env.USER_RESTORED_CHATS_PATH;
  return path.join(process.cwd(), 'user-restored-chats.json');
}

function readChatIds(filePath) {
  const res = readJsonFile(filePath);
  if (!res.ok) {
    return { chatIds: [], transientError: Boolean(res.transient) };
  }
  const raw = res.data;
  const ids = raw && raw.chatIds;
  return {
    chatIds: Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [],
    transientError: false,
  };
}

/**
 * 1:1 chats the user moved out of the archive. The user has overruled an
 * archive there, so model verdicts on that chat only alert the operator, as
 * for a saved contact.
 */
/** @param {{ filePath?: string | null }} [options] */
function createUserRestoredChats({ filePath = null } = {}) {
  const pathName = filePath || null;
  const loaded = pathName ? readChatIds(pathName) : { chatIds: [], transientError: false };
  const chatIds = new Set(loaded.chatIds.slice(-MAX_ENTRIES));
  let diskReadFailed = loaded.transientError;

  function persist() {
    if (!pathName) return;
    const merged = new Set(chatIds);
    let recoveredDisk = false;
    if (diskReadFailed) {
      const check = readChatIds(pathName);
      if (check.transientError) {
        throw new Error('refusing to overwrite user-restored chats after transient read failure');
      }
      for (const existing of check.chatIds) {
        if (!merged.has(existing)) merged.add(existing);
      }
      recoveredDisk = true;
    }
    while (merged.size > MAX_ENTRIES) {
      const oldest = merged.values().next().value;
      if (oldest === undefined) break;
      merged.delete(oldest);
    }
    writeJsonFileAtomic(pathName, { chatIds: [...merged] });
    if (recoveredDisk) {
      for (const existing of merged) chatIds.add(existing);
      diskReadFailed = false;
    }
  }

  return {
    path: pathName,
    /** @param {string | null | undefined} chatId */
    record(chatId) {
      const id = chatId == null ? '' : String(chatId);
      if (!id || chatIds.has(id)) return;
      chatIds.add(id);
      while (chatIds.size > MAX_ENTRIES) {
        const oldest = chatIds.values().next().value;
        if (oldest === undefined) break;
        chatIds.delete(oldest);
      }
      try {
        persist();
      } catch (err) {
        log.warn('failed to save user-restored chats', { error: err && err.message ? err.message : String(err) });
      }
    },
    /** @param {string | null | undefined} chatId */
    has(chatId) {
      return chatId != null && chatIds.has(String(chatId));
    },
  };
}

module.exports = {
  createUserRestoredChats,
  defaultUserRestoredChatsPath,
};
