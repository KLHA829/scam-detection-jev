'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

function defaultUserRestoredChatsPath(env = process.env) {
  if (env && env.USER_RESTORED_CHATS_PATH) return env.USER_RESTORED_CHATS_PATH;
  return path.join(process.cwd(), 'user-restored-chats.json');
}

function readChatIds(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const ids = raw && raw.chatIds;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  }
}

/**
 * 1:1 chats the user moved out of the archive. The user has overruled an
 * archive there, so model verdicts on that chat only alert the operator, as
 * for a saved contact.
 */
function createUserRestoredChats({ filePath } = {}) {
  const pathName = filePath || null;
  const chatIds = new Set(pathName ? readChatIds(pathName) : []);

  function persist() {
    if (!pathName) return;
    fs.mkdirSync(path.dirname(pathName), { recursive: true });
    const tmp = `${pathName}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ chatIds: [...chatIds] }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, pathName);
  }

  return {
    path: pathName,
    record(chatId) {
      const id = chatId == null ? '' : String(chatId);
      if (!id || chatIds.has(id)) return;
      chatIds.add(id);
      try {
        persist();
      } catch (err) {
        log.warn('failed to save user-restored chats', { error: err && err.message ? err.message : String(err) });
      }
    },
    has(chatId) {
      return chatId != null && chatIds.has(String(chatId));
    },
  };
}

module.exports = {
  createUserRestoredChats,
  defaultUserRestoredChatsPath,
};
