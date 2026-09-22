'use strict';

/**
 * Save the block reason as the WhatsApp contact name, then block and mute.
 * Archive stays with the caller so a failed block still hides the chat.
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

  if (!contact || typeof contact.block !== 'function') {
    throw new Error('contact.block unavailable');
  }
  await wait();
  await contact.block();
  result.blocked = true;

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

module.exports = {
  blockAndRename,
};
