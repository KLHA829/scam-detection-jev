'use strict';

const fs = require('fs');
const path = require('path');

function linkRules() {
  return require('./link-rules');
}

const DEFAULT_DATA_PATH = path.join(__dirname, '..', 'data', 'malicious-hosts.json');

let cachedHosts = null;
let cachedPath = null;

function normalizeHostEntry(entry) {
  return String(entry || '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\./, '');
}

/**
 * Maintained set of confirmed-malicious registrable hosts (exact label or suffix).
 * Edit `data/malicious-hosts.json` — add a host string; subdomains match via suffix.
 * Example: `"evil-pay.example"` also matches `https://login.evil-pay.example/`.
 */
function loadMaliciousHosts(dataPath = DEFAULT_DATA_PATH) {
  const resolved = path.resolve(dataPath);
  if (cachedHosts && cachedPath === resolved) return cachedHosts;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`malicious-hosts: cannot read ${resolved}: ${err.message}`);
  }
  const list = Array.isArray(raw.hosts) ? raw.hosts : [];
  cachedPath = resolved;
  cachedHosts = list.map(normalizeHostEntry).filter(Boolean);
  return cachedHosts;
}

function resetMaliciousHostsCache() {
  cachedHosts = null;
  cachedPath = null;
}

function hostMatchesMalicious(hostname, hosts) {
  const host = linkRules().hostnameOf(hostname);
  if (!host) return null;
  for (const suffix of hosts) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
  }
  return null;
}

function matchMaliciousHostInText(text, options = {}) {
  const hosts =
    options.hosts ||
    loadMaliciousHosts(options.dataPath || process.env.MALICIOUS_HOSTS_PATH);
  const body = text == null ? '' : String(text).normalize('NFKC');
  if (!body.trim() || !hosts.length) {
    return { hit: false, id: null, matchedHost: null, archiveReason: null };
  }
  for (const url of linkRules().extractUrls(body)) {
    const matched = hostMatchesMalicious(url.hostname, hosts);
    if (matched) {
      return {
        hit: true,
        id: 'malicious_host',
        matchedHost: matched,
        archiveReason: 'obvious_scam',
      };
    }
  }
  return { hit: false, id: null, matchedHost: null, archiveReason: null };
}

module.exports = {
  DEFAULT_DATA_PATH,
  loadMaliciousHosts,
  resetMaliciousHostsCache,
  hostMatchesMalicious,
  matchMaliciousHostInText,
};
