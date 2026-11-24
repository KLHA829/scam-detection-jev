// @ts-check
'use strict';

const { extractDigits, isLidId, phoneFromLidMapping } = require('./lid');
const { isOperatorSavedContact } = require('./block-policy');

async function phoneContactId(client, lidId) {
  if (!client || typeof client.getContactLidAndPhone !== 'function') return null;
  const phone = phoneFromLidMapping(await client.getContactLidAndPhone([lidId]));
  const digits = phone && !isLidId(phone) ? extractDigits(phone) : '';
  return digits ? `${digits}@c.us` : null;
}

/**
 * The contact whose saved status counts for a sender. The address book is keyed
 * by phone number, while a contact read from a `@lid` id carries the LID
 * record's `isMyContact`, so a `@lid` sender is judged on its phone-number
 * contact unless the LID record already says saved. Resolves to null when the
 * phone-number contact cannot be read: the caller treats that as unknown.
 */
async function loadSenderContact(client, { senderId, contact, botContactNames }) {
  const contactId = contact && contact.id && contact.id._serialized;
  if (!isLidId(senderId) && !isLidId(contactId)) return contact;
  if (isOperatorSavedContact(contact, botContactNames)) return contact;
  try {
    const phoneId = await phoneContactId(client, isLidId(senderId) ? senderId : contactId);
    if (!phoneId || typeof client.getContactById !== 'function') return null;
    return (await client.getContactById(phoneId)) || null;
  } catch {
    return null;
  }
}

module.exports = { loadSenderContact };
