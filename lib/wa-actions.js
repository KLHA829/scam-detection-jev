'use strict';

/**
 * Block first, then save the reason as the WhatsApp contact name, then mute.
 * A failed block must not write the number into the address book: a saved
 * contact is never auto-blocked again. Archive stays with the caller.
 * syncToAddressbook stays false: the name shows inside WhatsApp, not the phone OS book.
 */
async function blockAndRename({ client, contact, chat, digits, contactName, pause } = {}) {
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
  await contact.block();
  result.blocked = true;

  await wait();
  if (phone && contactName && client && typeof client.saveOrEditAddressbookContact === 'function') {
    try {
      await client.saveOrEditAddressbookContact(phone, contactName, '');
      result.renamed = true;
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
 * Unblock after operator confirmation. Does not unarchive. Clears only a known
 * block rename from an unsaved contact; optionally unmutes the chat.
 */
async function unblockContact({
  client,
  contact,
  chat,
  digits,
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

  const shouldClearRename =
    savedContact !== true &&
    (renamed === true || (renamed === undefined && savedContact === false));
  if (phone && shouldClearRename) {
    if (!client || typeof client.deleteAddressbookContact !== 'function') {
      result.errors.push('clear_rename:unavailable');
    } else {
      try {
        await wait();
        await client.deleteAddressbookContact(phone);
        result.clearedRename = true;
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

module.exports = {
  blockAndRename,
  unblockContact,
};
