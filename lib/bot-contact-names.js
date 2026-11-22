'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

function defaultBotContactNamesPath(env = process.env) {
  if (env && env.BOT_CONTACT_NAMES_PATH) return env.BOT_CONTACT_NAMES_PATH;
  return path.join(process.cwd(), 'bot-contact-names.json');
}

function phoneDigits(value) {
  return value == null ? '' : String(value).replace(/\D/g, '');
}

function contactPhone(contact) {
  if (!contact) return '';
  return phoneDigits(contact.number || (contact.id && contact.id.user));
}

function readNames(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = raw && raw.namesByPhone;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
    return Object.entries(entries).filter(([phone, name]) => phone && typeof name === 'string');
  } catch {
    return [];
  }
}

/**
 * Numbers whose WhatsApp contact name this bot wrote, with the name it wrote.
 * A contact the user saved under the same text is not in here, so it keeps the
 * saved-contact protection.
 */
function createBotContactNames({ filePath } = {}) {
  const pathName = filePath || null;
  const namesByPhone = new Map(pathName ? readNames(pathName) : []);

  function persist() {
    if (!pathName) return;
    fs.mkdirSync(path.dirname(pathName), { recursive: true });
    const tmp = `${pathName}.${process.pid}.tmp`;
    const body = { namesByPhone: Object.fromEntries(namesByPhone) };
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, pathName);
  }

  return {
    path: pathName,
    record(digits, name) {
      const phone = phoneDigits(digits);
      const written = typeof name === 'string' ? name.trim() : '';
      if (!phone || !written) return;
      namesByPhone.set(phone, written);
      try {
        persist();
      } catch (err) {
        log.warn('failed to save bot contact names', { error: err && err.message ? err.message : String(err) });
      }
    },
    /** True while the live name is still the one the bot wrote for this number. */
    wrote(contact) {
      const phone = contactPhone(contact);
      const name = contact && typeof contact.name === 'string' ? contact.name.trim() : '';
      return Boolean(phone && name && namesByPhone.get(phone) === name);
    },
  };
}

module.exports = {
  createBotContactNames,
  defaultBotContactNamesPath,
};
