'use strict';

const SKIP_TYPES = new Set([
  'notification',
  'e2e_notification',
  'gp2',
  'ciphertext',
  'call_log',
  'protocol',
  'broadcast_notification',
  'notification_template',
]);

function isOfficialWhatsAppName(name) {
  if (!name) return false;
  const n = String(name);
  const lower = n.toLowerCase();
  if (lower.includes('whatsapp business')) return true;
  if (lower.includes('whatsapp')) return true;
  if (n.includes('官方') && lower.includes('whatsapp')) return true;
  return false;
}

function shouldIgnoreMessage({
  fromMe,
  isGroup,
  type,
  isMe,
  pushName,
  contactName,
} = {}) {
  if (fromMe) return { ignore: true, reason: 'fromMe' };
  if (isMe) return { ignore: true, reason: 'isMe' };
  if (isGroup) return { ignore: true, reason: 'group' };
  if (type && SKIP_TYPES.has(String(type))) {
    return { ignore: true, reason: 'notification' };
  }
  if (
    isOfficialWhatsAppName(pushName) ||
    isOfficialWhatsAppName(contactName)
  ) {
    return { ignore: true, reason: 'official_whatsapp' };
  }
  return { ignore: false, reason: null };
}

module.exports = {
  SKIP_TYPES,
  isOfficialWhatsAppName,
  shouldIgnoreMessage,
};
