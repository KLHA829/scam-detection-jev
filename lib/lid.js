'use strict';

const { extractDigits } = require('./foreign-number');

function isLidId(id) {
  if (id == null) return false;
  const s = String(id);
  return s.endsWith('@lid') || s.includes('@lid');
}

function lidUserPart(id) {
  if (!isLidId(id)) return null;
  return String(id).split('@')[0];
}

function isLidObject(value) {
  if (!value || typeof value !== 'object') return false;
  return value.server === 'lid' || isLidId(value._serialized);
}

function phoneFromLidMapping(mapping) {
  if (mapping == null) return null;
  const list = Array.isArray(mapping) ? mapping : [mapping];
  for (const item of list) {
    const candidates = [];
    if (typeof item === 'string') candidates.push(item);
    else if (item && typeof item === 'object') {
      candidates.push(item.pn, item.phone, item.phoneNumber, item.wid);
      if (!isLidObject(item)) {
        candidates.push(item._serialized, item.user);
      }
      if (item.id && typeof item.id === 'object') {
        if (!isLidObject(item.id)) {
          candidates.push(item.id._serialized, item.id.user);
        }
      } else if (!isLidObject(item)) {
        candidates.push(item.id);
      }
    }
    for (const c of candidates) {
      if (c == null) continue;
      if (typeof c === 'object') {
        const nested = c._serialized || c.user;
        if (nested && !isLidId(nested)) return String(nested);
        continue;
      }
      const s = String(c);
      if (!s || isLidId(s)) continue;
      return s;
    }
  }
  return null;
}

/**
 * Resolve a WhatsApp id to real phone digits.
 * Never uses @lid digits as a phone number.
 */
async function resolveRealNumber(client, chatOrContactId, contact) {
  const rawId =
    chatOrContactId ||
    (contact && (contact.id?._serialized || contact.number || contact.id));

  if (!isLidId(rawId)) {
    const fromContact =
      (contact && (contact.number || contact.id?.user)) || rawId;
    const digits = extractDigits(fromContact);
    if (!digits) {
      return {
        digits: null,
        unresolvedLid: false,
        source: 'wid',
        rawId: rawId || null,
      };
    }
    return {
      digits,
      unresolvedLid: false,
      source: 'wid',
      rawId: rawId || null,
    };
  }

  if (!client || typeof client.getContactLidAndPhone !== 'function') {
    return {
      digits: null,
      unresolvedLid: true,
      source: 'lid',
      rawId,
    };
  }

  try {
    const mapping = await client.getContactLidAndPhone(rawId);
    const phone = phoneFromLidMapping(mapping);
    if (!phone || isLidId(phone)) {
      return { digits: null, unresolvedLid: true, source: 'lid', rawId };
    }
    const digits = extractDigits(phone);
    if (!digits) {
      return { digits: null, unresolvedLid: true, source: 'lid', rawId };
    }
    return {
      digits,
      unresolvedLid: false,
      source: 'lid_resolved',
      rawId,
    };
  } catch {
    return { digits: null, unresolvedLid: true, source: 'lid', rawId };
  }
}

module.exports = {
  isLidId,
  lidUserPart,
  phoneFromLidMapping,
  resolveRealNumber,
};
