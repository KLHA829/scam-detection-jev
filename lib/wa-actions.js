'use strict';

const { isUnsavedContact } = require('./block-policy');

/**
 * Block first, then save the reason as the WhatsApp contact name, then mute.
 * A failed block must not write the number into the address book: a saved
 * contact is never auto-blocked again. Archive stays with the caller.
 * syncToAddressbook stays false: the name shows inside WhatsApp, not the phone OS book.
 */
async function blockAndRename({
  client,
  contact,
  chat,
  digits,
  contactName,
  pause,
  refreshUnsavedContact,
  canRenameContact,
  botContactNames,
} = {}) {
  const result = {
    renamed: false,
    blocked: false,
    muted: false,
    errors: [],
  };
  const wait = typeof pause === 'function' ? pause : async () => {};
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');

  if (!contact || typeof contact.block !== 'function') {
    throw new Error('contact.block unavailable');
  }
  await wait();
  if (refreshUnsavedContact) {
    try {
      contact = await refreshUnsavedContact();
    } catch {
      contact = null;
    }
    if (!contact || !isUnsavedContact(contact, botContactNames)) return { ...result, skipped: 'contact_not_unsaved' };
  }
  await contact.block();
  result.blocked = true;

  await wait();
  if (refreshUnsavedContact) {
    try {
      contact = await refreshUnsavedContact();
    } catch {
      contact = null;
    }
    if (!contact || !isUnsavedContact(contact, botContactNames)) return result;
  }
  if (phone && contactName && client && typeof client.saveOrEditAddressbookContact === 'function') {
    try {
      if (!canRenameContact || await canRenameContact()) {
        await client.saveOrEditAddressbookContact(phone, contactName, '');
        result.renamed = true;
        if (botContactNames) botContactNames.record(contact, phone, contactName);
      }
    } catch (err) {
      result.errors.push(`rename:${err && err.message ? err.message : String(err)}`);
    }
  } else if (!phone) {
    result.errors.push('rename:no_phone');
  } else if (!contactName) {
    result.errors.push('rename:no_name');
  }

  if (chat && typeof chat.mute === 'function') {
    try {
      await wait();
      await chat.mute();
      result.muted = true;
    } catch (err) {
      result.errors.push(`mute:${err && err.message ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Unblock after operator confirmation. Does not unarchive. Deletes the address-book
 * entry only while it still has the exact bot-written block name.
 */
async function unblockContact({
  client,
  contact,
  chat,
  digits,
  blockContactName,
  renamed,
  savedContact,
  pause,
  unmute = true,
} = {}) {
  const result = {
    unblocked: false,
    clearedRename: false,
    unmuted: false,
    errors: [],
  };
  const wait = typeof pause === 'function' ? pause : async () => {};
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');

  if (!contact || typeof contact.unblock !== 'function') {
    throw new Error('contact.unblock unavailable');
  }
  await wait();
  await contact.unblock();
  result.unblocked = true;

  const writtenName =
    typeof blockContactName === 'string' ? blockContactName.trim() : '';
  const readName = (entry) => entry && typeof entry.name === 'string' ? entry.name.trim() : '';
  const currentName = readName(contact);
  const shouldClearRename =
    Boolean(phone) &&
    savedContact !== true &&
    renamed !== false &&
    writtenName !== '' &&
    currentName === writtenName;
  if (writtenName && currentName !== writtenName) {
    result.clearRenameSkipped = 'name_mismatch';
  }
  if (shouldClearRename) {
    if (!client || typeof client.deleteAddressbookContact !== 'function') {
      result.errors.push('clear_rename:unavailable');
    } else {
      try {
        await wait();
        const latestContact = chat && typeof chat.getContact === 'function'
          ? await chat.getContact()
          : contact;
        if (readName(latestContact) !== writtenName) {
          result.clearRenameSkipped = 'name_mismatch';
        } else {
          await client.deleteAddressbookContact(phone);
          result.clearedRename = true;
        }
      } catch (err) {
        result.errors.push(`clear_rename:${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  if (unmute && chat && typeof chat.unmute === 'function') {
    try {
      await wait();
      await chat.unmute();
      result.unmuted = true;
    } catch (err) {
      result.errors.push(`unmute:${err && err.message ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Name an unsaved sender with a warning label. Archive, block and mute stay off:
 * the chat stays where the user reads it. A saved contact keeps the name the user chose.
 * The verdict is rechecked after pacing, so an edit during the wait writes nothing.
 */
async function labelUnsavedContact({
  client,
  digits,
  contactName,
  pause,
  refreshUnsavedContact,
  botContactNames,
  isCurrent,
} = {}) {
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');
  if (!phone) return { labelled: false, skipped: 'no_phone' };
  if (!contactName) return { labelled: false, skipped: 'no_name' };
  if (!client || typeof client.saveOrEditAddressbookContact !== 'function') {
    return { labelled: false, skipped: 'unavailable' };
  }
  if (typeof pause === 'function') await pause();
  const contact = typeof refreshUnsavedContact === 'function'
    ? await refreshUnsavedContact().catch(() => null)
    : null;
  if (!isUnsavedContact(contact, botContactNames)) return { labelled: false, skipped: 'contact_not_unsaved' };
  if (typeof contact.name === 'string' && contact.name.trim() === contactName) {
    return { labelled: false, skipped: 'already_labelled' };
  }
  if (typeof isCurrent === 'function' && !isCurrent()) return { labelled: false, skipped: 'stale' };
  await client.saveOrEditAddressbookContact(phone, contactName, '');
  if (botContactNames) botContactNames.record(contact, phone, contactName);
  return { labelled: true };
}

module.exports = {
  blockAndRename,
  labelUnsavedContact,
  unblockContact,
};
