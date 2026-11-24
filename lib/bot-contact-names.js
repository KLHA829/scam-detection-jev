// @ts-check
'use strict';

const path = require('path');
const log = require('./log');
const { readJsonFile, writeJsonFileAtomic } = require('./json-store');

const MAX_ENTRIES = 5000;

function defaultBotContactNamesPath(env = process.env) {
  if (env && env.BOT_CONTACT_NAMES_PATH) return env.BOT_CONTACT_NAMES_PATH;
  return path.join(process.cwd(), 'bot-contact-names.json');
}

function contactKeys(contact, digits, extraIds = []) {
  const keys = [];
  const seen = new Set();
  const push = (value) => {
    const k = value == null ? '' : String(value).trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  };
  const id = contact && contact.id && (contact.id._serialized || (typeof contact.id === 'string' ? contact.id : null));
  push(id);
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');
  if (phone) push(`${phone}@c.us`);
  const extras = Array.isArray(extraIds) ? extraIds : [extraIds];
  for (const extra of extras) push(extra);
  return keys;
}

function readNames(filePath) {
  const res = readJsonFile(filePath);
  if (!res.ok) {
    return { entries: [], transientError: Boolean(res.transient) };
  }
  const raw = res.data;
  const entries = raw && raw.namesById;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { entries: [], transientError: false };
  }
  return {
    entries: Object.entries(entries).filter(([key, name]) => key && typeof name === 'string'),
    transientError: false,
  };
}

/**
 * WhatsApp contacts whose name this bot wrote, keyed by contact id (an `@lid`
 * id included) and by the resolved phone JID, with the name it wrote. A contact
 * the user saved under the same text is not in here, so it keeps the
 * saved-contact protection.
 */
/** @param {{ filePath?: string | null }} [options] */
function createBotContactNames({ filePath = null } = {}) {
  const pathName = filePath || null;
  const loaded = pathName ? readNames(pathName) : { entries: [], transientError: false };
  const namesById = new Map(loaded.entries.slice(-MAX_ENTRIES));
  let diskReadFailed = loaded.transientError;

  function persist() {
    if (!pathName) return;
    if (diskReadFailed) {
      const check = readNames(pathName);
      if (check.transientError) {
        throw new Error('refusing to overwrite bot-contact-names after transient read failure');
      }
      for (const [k, v] of check.entries) {
        if (!namesById.has(k)) namesById.set(k, v);
      }
      diskReadFailed = false;
    }
    while (namesById.size > MAX_ENTRIES) {
      namesById.delete(namesById.keys().next().value);
    }
    const body = { namesById: Object.fromEntries(namesById) };
    writeJsonFileAtomic(pathName, body);
  }

  return {
    path: pathName,
    /**
     * @param {any} contact
     * @param {any} digits
     * @param {string} name
     * @param {{ extraIds?: any }} [options]
     */
    record(contact, digits, name, { extraIds = [] } = {}) {
      const keys = contactKeys(contact, digits, extraIds);
      const written = typeof name === 'string' ? name.trim() : '';
      if (!keys.length || !written) return;
      for (const key of keys) {
        namesById.delete(key);
        namesById.set(key, written);
      }
      while (namesById.size > MAX_ENTRIES) {
        namesById.delete(namesById.keys().next().value);
      }
      try {
        persist();
      } catch (err) {
        log.warn('failed to save bot contact names', { error: err && err.message ? err.message : String(err) });
      }
    },
    /**
     * @param {any} contact
     * @param {any} digits
     * @param {{ extraIds?: any }} [options]
     */
    forget(contact, digits, { extraIds = [] } = {}) {
      const keys = contactKeys(contact, digits, extraIds).filter((key) => namesById.has(key));
      if (!keys.length) return;
      for (const key of keys) namesById.delete(key);
      try {
        persist();
      } catch (err) {
        log.warn('failed to save bot contact names', { error: err && err.message ? err.message : String(err) });
      }
    },
    /** True when the bot last wrote this name for this number, without a contact lookup. */
    wroteForNumber(digits, name) {
      const phone = digits == null ? '' : String(digits).replace(/\D/g, '');
      return Boolean(phone) && Boolean(name) && namesById.get(`${phone}@c.us`) === name;
    },
    /** True while the live name is still the one the bot wrote for this contact. */
    wrote(contact) {
      const name = contact && typeof contact.name === 'string' ? contact.name.trim() : '';
      return Boolean(name) && contactKeys(contact).some((key) => namesById.get(key) === name);
    },
  };
}

module.exports = {
  createBotContactNames,
  defaultBotContactNamesPath,
};
