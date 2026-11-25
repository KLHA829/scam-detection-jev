// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

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

function hasNonEmptyEnv(value) {
  return value != null && String(value).trim() !== '';
}

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

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ authPath?: string | null, dbPath?: string | null }} [options]
 */
function resolveTransportName(env = process.env, { authPath = null, dbPath = null } = {}) {
  const raw = env && env.WA_TRANSPORT != null ? String(env.WA_TRANSPORT).trim().toLowerCase() : '';
  if (raw) return raw;

  const autoStartRaw =
    env && env.WA_BRIDGE_AUTO_START != null
      ? String(env.WA_BRIDGE_AUTO_START).trim().toLowerCase()
      : '';
  const explicitBridge =
    hasNonEmptyEnv(env && env.WA_BRIDGE_URL) ||
    hasNonEmptyEnv(env && env.WA_BRIDGE_TOKEN) ||
    autoStartRaw === '1' ||
    autoStartRaw === 'true';

  if (!explicitBridge && authPath && fs.existsSync(authPath)) {
    const resolvedDb =
      dbPath ||
      (hasNonEmptyEnv(env && env.WA_BRIDGE_DB_PATH)
        ? String(env && env.WA_BRIDGE_DB_PATH).trim()
        : path.join(process.cwd(), 'wa-bridge.db'));
    if (!fs.existsSync(resolvedDb)) {
      return 'wwebjs';
    }
  }
  return 'whatsmeow';
}

/** @param {{ env?: NodeJS.ProcessEnv, authPath?: string, dbPath?: string }} [options] */
function createWhatsAppTransport({ env = process.env, authPath = undefined, dbPath = undefined } = {}) {
  const effectiveAuthPath = authPath || path.join(process.cwd(), '.wwebjs_auth');
  const effectiveDbPath =
    dbPath ||
    (hasNonEmptyEnv(env && env.WA_BRIDGE_DB_PATH)
      ? String(env && env.WA_BRIDGE_DB_PATH).trim()
      : path.join(process.cwd(), 'wa-bridge.db'));
  const name = resolveTransportName(env, { authPath: effectiveAuthPath, dbPath: effectiveDbPath });
  if (name === 'wwebjs') {
    return createWwebjsTransport({ authPath, env });
  }
  if (name === 'whatsmeow') {
    return createWhatsmeowTransport({ env, dbPath: effectiveDbPath });
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
