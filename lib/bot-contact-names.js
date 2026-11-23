'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

function defaultBotContactNamesPath(env = process.env) {
  if (env && env.BOT_CONTACT_NAMES_PATH) return env.BOT_CONTACT_NAMES_PATH;
  return path.join(process.cwd(), 'bot-contact-names.json');
}

function contactKeys(contact, digits) {
  const keys = [];
  const id = contact && contact.id && contact.id._serialized;
  if (id) keys.push(String(id));
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');
  if (phone) keys.push(`${phone}@c.us`);
  return keys;
}

function readNames(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = raw && raw.namesById;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
    return Object.entries(entries).filter(([key, name]) => key && typeof name === 'string');
  } catch {
    return [];
  }
}

/**
 * WhatsApp contacts whose name this bot wrote, keyed by contact id (an `@lid`
 * id included) and by the resolved phone JID, with the name it wrote. A contact
 * the user saved under the same text is not in here, so it keeps the
 * saved-contact protection.
 */
function createBotContactNames({ filePath } = {}) {
  const pathName = filePath || null;
  const namesById = new Map(pathName ? readNames(pathName) : []);

  function persist() {
    if (!pathName) return;
    fs.mkdirSync(path.dirname(pathName), { recursive: true });
    const tmp = `${pathName}.${process.pid}.tmp`;
    const body = { namesById: Object.fromEntries(namesById) };
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, pathName);
  }

  return {
    path: pathName,
    record(contact, digits, name) {
      const keys = contactKeys(contact, digits);
      const written = typeof name === 'string' ? name.trim() : '';
      if (!keys.length || !written) return;
      for (const key of keys) namesById.set(key, written);
      try {
        persist();
      } catch (err) {
        log.warn('failed to save bot contact names', { error: err && err.message ? err.message : String(err) });
      }
    },
    forget(contact, digits) {
      const keys = contactKeys(contact, digits).filter((key) => namesById.has(key));
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
