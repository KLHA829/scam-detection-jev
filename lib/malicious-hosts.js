// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const log = require('./log');

function linkRules() {
  return require('./link-rules');
}

const DEFAULT_DATA_PATH = path.join(__dirname, '..', 'data', 'malicious-hosts.json');

/** Shipped test-infra hosts (RFC 2606 / Safe Browsing / WICAR) — not operator-confirmed HK scam domains. */
const TEST_INFRA_HOSTS = new Set([
  'malicious-block-test.invalid',
  'malware.testing.google.test',
  'wicar.org',
]);

function allowEmptyHostsReload(env = process.env) {
  const v = env && env.MALICIOUS_HOSTS_ALLOW_EMPTY;
  return v === '1' || String(v).toLowerCase() === 'true';
}

function warnIfTestInfraOnly(hosts, resolvedPath) {
  if (!hosts.length) return;
  if (hosts.every((h) => TEST_INFRA_HOSTS.has(h))) {
    log.warn(
      'malicious-hosts: list contains only test-infra hosts; add operator-confirmed scam domains before relying on auto-block',
      { path: resolvedPath, hosts },
    );
  }
}

let cachedHosts = null;
let cachedPath = null;
let activeWatcher = null;

function normalizeHostEntry(entry) {
  return String(entry || '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\./, '');
}

function resolveMaliciousHostsPath(dataPath, env = process.env) {
  const raw = dataPath || (env && env.MALICIOUS_HOSTS_PATH) || DEFAULT_DATA_PATH;
  return path.resolve(raw);
}

/**
 * Maintained set of confirmed-malicious registrable hosts (exact label or suffix).
 * Edit `data/malicious-hosts.json` — add a host string; subdomains match via suffix.
 * Example: `"evil-pay.example"` also matches `https://login.evil-pay.example/`.
 */
function reloadMaliciousHosts(dataPath, env = process.env) {
  const resolved = resolveMaliciousHostsPath(dataPath, env);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`malicious-hosts: cannot read ${resolved}: ${err.message}`, {
      cause: err,
    });
  }
  const list = Array.isArray(raw.hosts) ? raw.hosts : [];
  const next = list.map(normalizeHostEntry).filter(Boolean);
  if (
    next.length === 0 &&
    cachedHosts &&
    cachedHosts.length > 0 &&
    cachedPath === resolved &&
    !allowEmptyHostsReload(env)
  ) {
    log.warn('malicious-hosts: empty hosts[] ignored; keeping previous list', {
      path: resolved,
      previousCount: cachedHosts.length,
    });
    return cachedHosts;
  }
  cachedPath = resolved;
  cachedHosts = next;
  warnIfTestInfraOnly(cachedHosts, resolved);
  return cachedHosts;
}

function loadMaliciousHosts(dataPath = DEFAULT_DATA_PATH) {
  const resolved = resolveMaliciousHostsPath(
    dataPath === DEFAULT_DATA_PATH ? undefined : dataPath,
  );
  if (cachedHosts && cachedPath === resolved) return cachedHosts;
  return reloadMaliciousHosts(resolved);
}

function resetMaliciousHostsCache() {
  cachedHosts = null;
  cachedPath = null;
}

function stopMaliciousHostsWatcher() {
  if (!activeWatcher) return;
  if (activeWatcher.pending) clearTimeout(activeWatcher.pending);
  if (activeWatcher.kind === 'watchFile' && activeWatcher.listener) {
    fs.unwatchFile(activeWatcher.path, activeWatcher.listener);
  } else if (activeWatcher.handle) {
    activeWatcher.handle.close();
  }
  activeWatcher = null;
}

function startMaliciousHostsWatcher(options = {}) {
  const env = options.env || process.env;
  const resolved = resolveMaliciousHostsPath(options.dataPath, env);
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 250;
  const onReload = typeof options.onReload === 'function' ? options.onReload : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  stopMaliciousHostsWatcher();

  let watchPath = resolved;
  try {
    watchPath = fs.realpathSync(resolved);
  } catch {}

  const state = { kind: null, path: resolved, listener: null, handle: null, pending: null };

  function scheduleReload() {
    if (state.pending) clearTimeout(state.pending);
    state.pending = setTimeout(() => {
      state.pending = null;
      try {
        const hosts = reloadMaliciousHosts(resolved, env);
        onReload(hosts);
      } catch (err) {
        onError(err);
      }
    }, debounceMs);
  }

  try {
    state.kind = 'watch';
    state.handle = fs.watch(
      path.dirname(watchPath),
      { persistent: false },
      (eventType, filename) => {
        if (filename != null && filename.toString() !== path.basename(watchPath)) return;
        if (eventType === 'change' || eventType === 'rename') scheduleReload();
      },
    );
    activeWatcher = state;
  } catch {
    try {
      state.kind = 'watchFile';
      state.listener = () => scheduleReload();
      fs.watchFile(resolved, { interval: debounceMs }, state.listener);
      activeWatcher = state;
    } catch (fallbackErr) {
      onError(fallbackErr);
      return { path: resolved, stop: stopMaliciousHostsWatcher };
    }
  }

  return { path: resolved, stop: stopMaliciousHostsWatcher };
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
  return matchMaliciousHostInCandidates(linkRules().extractUrlCandidates(text), options);
}

function matchMaliciousHostInCandidates(candidates, options = {}) {
  const hosts =
    options.hosts ||
    loadMaliciousHosts(options.dataPath || process.env.MALICIOUS_HOSTS_PATH);
  let emailHost = null;
  for (const { url, email } of candidates) {
    const matched = hostMatchesMalicious(url.hostname, hosts);
    if (!matched) continue;
    if (email) {
      emailHost ??= matched;
      continue;
    }
    return {
      hit: true,
      id: 'malicious_host',
      matchedHost: matched,
      archiveReason: 'obvious_scam',
    };
  }
  if (emailHost) {
    return {
      hit: true,
      id: 'malicious_email_host',
      matchedHost: emailHost,
      archiveReason: 'obvious_scam',
    };
  }
  return { hit: false, id: null, matchedHost: null, archiveReason: null };
}

module.exports = {
  DEFAULT_DATA_PATH,
  resolveMaliciousHostsPath,
  loadMaliciousHosts,
  reloadMaliciousHosts,
  resetMaliciousHostsCache,
  startMaliciousHostsWatcher,
  stopMaliciousHostsWatcher,
  hostMatchesMalicious,
  matchMaliciousHostInText,
  matchMaliciousHostInCandidates,
};
