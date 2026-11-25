// @ts-check
'use strict';

const { extractDigits, isLidId, phoneFromLidMapping } = require('./lid');
const { isOperatorSavedContact } = require('./block-policy');
const { serializedId } = require('./self-chat');

async function phoneContactId(client, lidId) {
  const resolveLid =
    client && typeof client.resolveLidMappings === 'function'
      ? (ids) => client.resolveLidMappings(ids)
      : client && typeof client.getContactLidAndPhone === 'function'
        ? (ids) => client.getContactLidAndPhone(ids)
        : null;
  if (!resolveLid) return null;
  const phone = phoneFromLidMapping(await resolveLid([lidId]));
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
  const contactId = serializedId(contact && contact.id);
  if (!isLidId(senderId) && !isLidId(contactId)) return contact;
  const lidSaved = isOperatorSavedContact(contact, botContactNames);
  try {
    const phoneId = await phoneContactId(client, isLidId(senderId) ? senderId : contactId);
    const readContact =
      client && typeof client.getContact === 'function'
        ? (id) => client.getContact(id)
        : client && typeof client.getContactById === 'function'
          ? (id) => client.getContactById(id)
          : null;
    if (!phoneId || !readContact) return lidSaved ? contact : null;
    const phoneContact = (await readContact(phoneId)) || null;
    if (lidSaved) {
      const lidName = contact && typeof contact.name === 'string' ? contact.name.trim() : '';
      const phoneName = phoneContact && typeof phoneContact.name === 'string' ? phoneContact.name.trim() : '';
      if (phoneContact && botContactNames && botContactNames.wrote(phoneContact) && lidName && lidName === phoneName) {
        return phoneContact;
      }
      return contact;
    }
    return phoneContact;
  } catch {
    return lidSaved ? contact : null;
  }
}

module.exports = { loadSenderContact };
