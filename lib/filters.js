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

const OFFICIAL_WHATSAPP_IDS = new Set([
  'status@broadcast',
  '0@c.us',
  '0@s.whatsapp.net',
]);

function isOfficialWhatsAppId(id) {
  if (!id) return false;
  const raw = String(id).trim().toLowerCase();
  if (OFFICIAL_WHATSAPP_IDS.has(raw)) return true;
  const user = raw.split('@')[0];
  return user === '0' && (raw.endsWith('@c.us') || raw.endsWith('@s.whatsapp.net'));
}

function isChannelId(id) {
  if (!id) return false;
  return String(id).trim().toLowerCase().endsWith('@newsletter');
}

function shouldIgnoreMessage({
  fromMe,
  isGroup,
  isChannel,
  type,
  isMe,
  chatId,
  from,
} = {}) {
  if (fromMe) return { ignore: true, reason: 'fromMe' };
  if (isMe) return { ignore: true, reason: 'isMe' };
  if (isGroup) return { ignore: true, reason: 'group' };
  if (isChannel || isChannelId(chatId) || isChannelId(from)) {
    return { ignore: true, reason: 'channel' };
  }
  if (type && SKIP_TYPES.has(String(type))) {
    return { ignore: true, reason: 'notification' };
  }
  if (isOfficialWhatsAppId(chatId) || isOfficialWhatsAppId(from)) {
    return { ignore: true, reason: 'official_whatsapp' };
  }
  return { ignore: false, reason: null };
}

module.exports = {
  SKIP_TYPES,
  OFFICIAL_WHATSAPP_IDS,
  isOfficialWhatsAppId,
  isChannelId,
  shouldIgnoreMessage,
};
