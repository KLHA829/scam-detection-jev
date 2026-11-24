// @ts-check
'use strict';

const path = require('path');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const { serializedId, messageIdOf } = require('../self-chat');

const WA_TRANSPORT = Symbol.for('scam-detection-jev.wa-transport');
const NORMALIZED_CONTACT = Symbol.for('scam-detection-jev.wa-contact');
const NORMALIZED_CHAT = Symbol.for('scam-detection-jev.wa-chat');
const NORMALIZED_MESSAGE = Symbol.for('scam-detection-jev.wa-message');
const NORMALIZED_VOTE = Symbol.for('scam-detection-jev.wa-vote');
const RAW_OBJECT = Symbol('wwebjs-raw');

function unwrapRaw(value) {
  return value && typeof value === 'object' && value[RAW_OBJECT] ? value[RAW_OBJECT] : value;
}

function puppeteerArgs(
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  forceNoSandbox = process.env.PUPPETEER_NO_SANDBOX === '1',
) {
  const args = ['--disable-dev-shm-usage'];
  if (uid === 0 || forceNoSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
  return args;
}

function createWwebjsClient({
  authPath = path.join(process.cwd(), '.wwebjs_auth'),
  env = process.env,
} = {}) {
  const puppeteer = {
    args: puppeteerArgs(
      typeof process.getuid === 'function' ? process.getuid() : null,
      Boolean(env && env.PUPPETEER_NO_SANDBOX === '1'),
    ),
  };
  if (env && env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteer.executablePath = env.PUPPETEER_EXECUTABLE_PATH;
  }
  return new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer,
  });
}

function normalizeWwebjsContact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw[NORMALIZED_CONTACT]) return raw;
  return {
    id: serializedId(raw.id),
    number: typeof raw.number === 'string' ? raw.number : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    pushname: typeof raw.pushname === 'string' ? raw.pushname : undefined,
    isMyContact: typeof raw.isMyContact === 'boolean' ? raw.isMyContact : undefined,
    isMe: typeof raw.isMe === 'boolean' ? raw.isMe : undefined,
    [NORMALIZED_CONTACT]: true,
    [RAW_OBJECT]: raw,
  };
}

function normalizeWwebjsChat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw[NORMALIZED_CHAT]) return raw;
  return {
    id: serializedId(raw.id),
    isGroup: Boolean(raw.isGroup),
    isChannel: Boolean(raw.isChannel),
    [NORMALIZED_CHAT]: true,
    [RAW_OBJECT]: raw,
  };
}

function normalizeWwebjsMessage(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw[NORMALIZED_MESSAGE]) return raw;
  const id =
    serializedId(raw.id) ||
    (raw.id && typeof raw.id === 'object' && typeof raw.id.id === 'string' ? raw.id.id : null);
  const notifyName =
    typeof raw.notifyName === 'string'
      ? raw.notifyName
      : raw._data && typeof raw._data.notifyName === 'string'
        ? raw._data.notifyName
        : undefined;
  return {
    id,
    from: typeof raw.from === 'string' ? raw.from : serializedId(raw.from),
    author: typeof raw.author === 'string' ? raw.author : serializedId(raw.author),
    fromMe: Boolean(raw.fromMe),
    type: raw.type,
    body: raw.body || '',
    isForwarded: raw.isForwarded === true,
    notifyName,
    hasQuotedMsg: Boolean(raw.hasQuotedMsg),
    async getChat() {
      if (typeof raw.getChat !== 'function') return null;
      return normalizeWwebjsChat(await raw.getChat());
    },
    async getContact() {
      if (typeof raw.getContact !== 'function') return null;
      return normalizeWwebjsContact(await raw.getContact());
    },
    async getQuotedMessageId() {
      if (typeof raw.getQuotedMessageId === 'function') return raw.getQuotedMessageId();
      if (!raw.hasQuotedMsg || typeof raw.getQuotedMessage !== 'function') return null;
      const quoted = await raw.getQuotedMessage();
      return serializedId(quoted && quoted.id);
    },
    async forward(targetChatId) {
      if (typeof raw.forward !== 'function') {
        throw new Error('message.forward unavailable');
      }
      await raw.forward(targetChatId);
    },
    [NORMALIZED_MESSAGE]: true,
    [RAW_OBJECT]: raw,
  };
}

function normalizeWwebjsVote(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw[NORMALIZED_VOTE]) return raw;
  const parent = raw.parentMessage || raw.parentMsg || null;
  const parentMessageId =
    serializedId(parent && parent.id) ||
    serializedId(raw.parentMsgKey) ||
    (typeof raw.parentMessageId === 'string' ? raw.parentMessageId : null);
  const selectedOptions = Array.isArray(raw.selectedOptions)
    ? raw.selectedOptions
        .map((option) =>
          typeof option === 'string' ? option : option && option.name ? String(option.name) : '',
        )
        .filter(Boolean)
    : [];
  return {
    parentMessageId,
    selectedOptions,
    [NORMALIZED_VOTE]: true,
    [RAW_OBJECT]: raw,
  };
}

function wrapWwebjsClient(client) {
  if (!client || typeof client !== 'object') {
    throw new Error('wwebjs client is required');
  }
  if (client[WA_TRANSPORT]) return client;

  const transport = {
    [WA_TRANSPORT]: true,
    name: 'wwebjs',
    initialize() {
      return client.initialize();
    },
    destroy() {
      return typeof client.destroy === 'function' ? client.destroy() : Promise.resolve();
    },
    getSelfWid() {
      return serializedId(client.info && client.info.wid);
    },
    getSelfLid() {
      return serializedId(client.info && client.info.lid);
    },
    on(event, handler) {
      if (event === 'message' || event === 'message_create') {
        client.on(event, (rawMsg) => handler(normalizeWwebjsMessage(rawMsg)));
        return;
      }
      if (event === 'message_edit') {
        client.on(event, (rawMsg, newBody, prevBody) => {
          if (rawMsg && typeof newBody === 'string' && newBody !== prevBody) {
            rawMsg.body = newBody;
          }
          return handler(normalizeWwebjsMessage(rawMsg), newBody, prevBody);
        });
        return;
      }
      if (event === 'vote_update') {
        client.on(event, (rawVote) => handler(normalizeWwebjsVote(rawVote)));
        return;
      }
      client.on(event, handler);
    },
    async sendText(chatId, text) {
      const sent = await client.sendMessage(chatId, text);
      return { id: messageIdOf(sent) };
    },
    async sendPoll(chatId, { name, options, allowMultipleAnswers = false }) {
      const pollOptions = /** @type {any} */ ({ allowMultipleAnswers });
      const sent = await client.sendMessage(
        chatId,
        new Poll(name, options, pollOptions),
      );
      return { id: messageIdOf(sent) };
    },
    async getChat(chatId) {
      if (typeof client.getChatById !== 'function') return null;
      return normalizeWwebjsChat(await client.getChatById(chatId));
    },
    async getContact(contactId) {
      if (typeof client.getContactById !== 'function') return null;
      return normalizeWwebjsContact(await client.getContactById(contactId));
    },
    async getChatContact(chat) {
      const rawChat = unwrapRaw(chat);
      if (!rawChat || typeof rawChat.getContact !== 'function') return null;
      return normalizeWwebjsContact(await rawChat.getContact());
    },
    async archiveChat(chat) {
      const rawChat = unwrapRaw(chat);
      if (!rawChat || typeof rawChat.archive !== 'function') {
        throw new Error('chat.archive unavailable');
      }
      await rawChat.archive();
    },
    async muteChat(chat) {
      const rawChat = unwrapRaw(chat);
      if (!rawChat || typeof rawChat.mute !== 'function') return false;
      await rawChat.mute();
      return true;
    },
    async unmuteChat(chat) {
      const rawChat = unwrapRaw(chat);
      if (!rawChat || typeof rawChat.unmute !== 'function') return false;
      await rawChat.unmute();
      return true;
    },
    canBlockContact(contact) {
      const rawContact = unwrapRaw(contact);
      return Boolean(rawContact && typeof rawContact.block === 'function');
    },
    async blockContact(contact) {
      const rawContact = unwrapRaw(contact);
      if (!rawContact || typeof rawContact.block !== 'function') {
        throw new Error('contact.block unavailable');
      }
      await rawContact.block();
    },
    canUnblockContact(contact) {
      const rawContact = unwrapRaw(contact);
      return Boolean(rawContact && typeof rawContact.unblock === 'function');
    },
    async unblockContact(contact) {
      const rawContact = unwrapRaw(contact);
      if (!rawContact || typeof rawContact.unblock !== 'function') {
        throw new Error('contact.unblock unavailable');
      }
      await rawContact.unblock();
    },
    get saveContactName() {
      if (typeof client.saveOrEditAddressbookContact !== 'function') return undefined;
      return async (phone, name) => {
        await client.saveOrEditAddressbookContact(phone, name, '');
      };
    },
    get deleteContactName() {
      if (typeof client.deleteAddressbookContact !== 'function') return undefined;
      return async (phone) => {
        await client.deleteAddressbookContact(phone);
      };
    },
    get resolveLidMappings() {
      if (typeof client.getContactLidAndPhone !== 'function') return undefined;
      return async (ids) => client.getContactLidAndPhone(ids);
    },
    async isSelfChatId(chatId) {
      const wid = this.getSelfWid();
      if (!wid || !chatId) return false;
      if (chatId === wid) return true;
      const selfLid = this.getSelfLid();
      if (selfLid && chatId === selfLid) return true;
      if (typeof client.getContactLidAndPhone !== 'function') return false;
      const mappings = await client.getContactLidAndPhone([wid]);
      return (
        Array.isArray(mappings) &&
        mappings.some(
          ({ lid, pn }) =>
            (pn === wid && lid === chatId) || (lid === wid && pn === chatId),
        )
      );
    },
  };
  return transport;
}

/** @param {{ authPath?: string, env?: NodeJS.ProcessEnv }} [options] */
function createWwebjsTransport({ authPath = undefined, env = process.env } = {}) {
  return wrapWwebjsClient(createWwebjsClient({ authPath, env }));
}

module.exports = {
  WA_TRANSPORT,
  NORMALIZED_CONTACT,
  NORMALIZED_CHAT,
  NORMALIZED_MESSAGE,
  NORMALIZED_VOTE,
  puppeteerArgs,
  createWwebjsClient,
  createWwebjsTransport,
  wrapWwebjsClient,
  normalizeWwebjsContact,
  normalizeWwebjsChat,
  normalizeWwebjsMessage,
  normalizeWwebjsVote,
};
