'use strict';

const { isUnsavedContact } = require('./block-policy');

function saveNameFn(client) {
  if (!client) return null;
  if (typeof client.saveContactName === 'function') {
    return (phone, name) => client.saveContactName(phone, name);
  }
  if (typeof client.saveOrEditAddressbookContact === 'function') {
    return (phone, name) => client.saveOrEditAddressbookContact(phone, name, '');
  }
  return null;
}

function deleteNameFn(client) {
  if (!client) return null;
  if (typeof client.deleteContactName === 'function') {
    return (phone) => client.deleteContactName(phone);
  }
  if (typeof client.deleteAddressbookContact === 'function') {
    return (phone) => client.deleteAddressbookContact(phone);
  }
  return null;
}

function canBlock(client, contact) {
  if (!contact) return false;
  if (client && typeof client.canBlockContact === 'function') {
    return client.canBlockContact(contact);
  }
  if (client && typeof client.blockContact === 'function') return true;
  return typeof contact.block === 'function';
}

async function performBlock(client, contact) {
  if (client && typeof client.blockContact === 'function') {
    await client.blockContact(contact);
    return;
  }
  await contact.block();
}

function canUnblock(client, contact) {
  if (!contact) return false;
  if (client && typeof client.canUnblockContact === 'function') {
    return client.canUnblockContact(contact);
  }
  if (client && typeof client.unblockContact === 'function') return true;
  return typeof contact.unblock === 'function';
}

async function performUnblock(client, contact) {
  if (client && typeof client.unblockContact === 'function') {
    await client.unblockContact(contact);
    return;
  }
  await contact.unblock();
}

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
  extraIds,
  isCurrent,
} = {}) {
  const result = {
    renamed: false,
    blocked: false,
    muted: false,
    errors: [],
  };
  const wait = typeof pause === 'function' ? pause : async () => {};
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');

  if (!canBlock(client, contact)) {
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
  if (typeof isCurrent === 'function' && !isCurrent()) return { ...result, skipped: 'stale' };
  await performBlock(client, contact);
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
  const saveName = saveNameFn(client);
  if (phone && contactName && saveName) {
    try {
      if (!canRenameContact || await canRenameContact()) {
        await saveName(phone, contactName);
        result.renamed = true;
        if (botContactNames) botContactNames.record(contact, phone, contactName, { extraIds });
      }
    } catch (err) {
      result.errors.push(`rename:${err && err.message ? err.message : String(err)}`);
    }
  } else if (!phone) {
    result.errors.push('rename:no_phone');
  } else if (!contactName) {
    result.errors.push('rename:no_name');
  }

  if (chat && (client && typeof client.muteChat === 'function' || typeof chat.mute === 'function')) {
    try {
      await wait();
      if (client && typeof client.muteChat === 'function') {
        result.muted = Boolean(await client.muteChat(chat));
      } else {
        await chat.mute();
        result.muted = true;
      }
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
  refreshContact,
  botContactNames,
  extraIds,
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

  if (!canUnblock(client, contact)) {
    throw new Error('contact.unblock unavailable');
  }
  await wait();
  await performUnblock(client, contact);
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
    const deleteName = deleteNameFn(client);
    if (!deleteName) {
      result.errors.push('clear_rename:unavailable');
    } else {
      try {
        await wait();
        const latestContact = typeof refreshContact === 'function'
          ? await refreshContact(chat)
          : (client && typeof client.getChatContact === 'function'
              ? await client.getChatContact(chat)
              : (chat && typeof chat.getContact === 'function'
                  ? await chat.getContact()
                  : contact));
        if (readName(latestContact) !== writtenName) {
          result.clearRenameSkipped = 'name_mismatch';
        } else {
          await deleteName(phone);
          result.clearedRename = true;
          if (botContactNames) botContactNames.forget(latestContact || contact, phone, { extraIds });
        }
      } catch (err) {
        result.errors.push(`clear_rename:${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  if (unmute && chat && (client && typeof client.unmuteChat === 'function' || typeof chat.unmute === 'function')) {
    try {
      await wait();
      if (client && typeof client.unmuteChat === 'function') {
        result.unmuted = Boolean(await client.unmuteChat(chat));
      } else {
        await chat.unmute();
        result.unmuted = true;
      }
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
  extraIds,
  isCurrent,
} = {}) {
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');
  if (!phone) return { labelled: false, skipped: 'no_phone' };
  if (!contactName) return { labelled: false, skipped: 'no_name' };
  const saveName = saveNameFn(client);
  if (!saveName) {
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
  await saveName(phone, contactName);
  if (botContactNames) botContactNames.record(contact, phone, contactName, { extraIds });
  return { labelled: true };
}

/**
 * Remove a pitch label once a later review finds the chat ordinary. Only a name this bot
 * wrote is deleted; a contact the user saved, even under the same text, is left alone.
 * The verdict and the name are rechecked after pacing.
 */
async function clearUnsavedContactLabel({
  client,
  digits,
  contactName,
  pause,
  refreshUnsavedContact,
  botContactNames,
  extraIds,
  isCurrent,
} = {}) {
  const phone = digits == null ? '' : String(digits).replace(/\D/g, '');
  if (!phone || !contactName || !botContactNames) return { cleared: false, skipped: 'unavailable' };
  const deleteName = deleteNameFn(client);
  if (!deleteName) {
    return { cleared: false, skipped: 'unavailable' };
  }
  const labelled = async () => {
    const contact = typeof refreshUnsavedContact === 'function'
      ? await refreshUnsavedContact().catch(() => null)
      : null;
    const name = contact && typeof contact.name === 'string' ? contact.name.trim() : '';
    return name === contactName && botContactNames.wrote(contact) ? contact : null;
  };
  if (!await labelled()) return { cleared: false, skipped: 'not_labelled' };
  if (typeof pause === 'function') await pause();
  const contact = await labelled();
  if (!contact) return { cleared: false, skipped: 'not_labelled' };
  if (typeof isCurrent === 'function' && !isCurrent()) return { cleared: false, skipped: 'stale' };
  await deleteName(phone);
  botContactNames.forget(contact, phone, { extraIds });
  return { cleared: true };
}

module.exports = {
  blockAndRename,
  clearUnsavedContactLabel,
  labelUnsavedContact,
  unblockContact,
};
