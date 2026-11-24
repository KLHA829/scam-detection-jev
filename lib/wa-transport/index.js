// @ts-check
'use strict';

const {
  WA_TRANSPORT,
  puppeteerArgs,
  createWwebjsClient,
  createWwebjsTransport,
  wrapWwebjsClient,
  normalizeWwebjsMessage,
} = require('./wwebjs');
const { createWhatsmeowTransport } = require('./whatsmeow');

const SUPPORTED_TRANSPORTS = ['wwebjs', 'whatsmeow'];

function isWaTransport(value) {
  return Boolean(value && typeof value === 'object' && value[WA_TRANSPORT] === true);
}

function ensureTransport(clientOrTransport) {
  if (!clientOrTransport) return null;
  if (isWaTransport(clientOrTransport)) return clientOrTransport;
  return wrapWwebjsClient(clientOrTransport);
}

function normalizeMessage(msg) {
  return normalizeWwebjsMessage(msg);
}

function resolveTransportName(env = process.env) {
  const raw = env && env.WA_TRANSPORT != null ? String(env.WA_TRANSPORT).trim().toLowerCase() : '';
  return raw || 'wwebjs';
}

/** @param {{ env?: NodeJS.ProcessEnv, authPath?: string }} [options] */
function createWhatsAppTransport({ env = process.env, authPath = undefined } = {}) {
  const name = resolveTransportName(env);
  if (name === 'wwebjs') {
    return createWwebjsTransport({ authPath, env });
  }
  if (name === 'whatsmeow') {
    return createWhatsmeowTransport({ env });
  }
  throw new Error(
    `Unsupported WA_TRANSPORT "${name}" (supported: ${SUPPORTED_TRANSPORTS.join(', ')})`,
  );
}

module.exports = {
  WA_TRANSPORT,
  SUPPORTED_TRANSPORTS,
  isWaTransport,
  ensureTransport,
  normalizeMessage,
  resolveTransportName,
  createWhatsAppTransport,
  createWhatsmeowTransport,
  createWwebjsClient,
  createWwebjsTransport,
  wrapWwebjsClient,
  puppeteerArgs,
};
