// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { domainToUnicode } = require('node:url');

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
  const host = entry
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\./, '')
    .replace(/\.+$/, '');
  if (/[/:?#@\\]/.test(host)) return host;
  return domainToUnicode(host) || host;
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.hosts)) {
    throw new Error(`malicious-hosts: expected { "hosts": [...] } in ${resolved}`);
  }
  const list = raw.hosts;
  const badIndex = list.findIndex((entry) => typeof entry !== 'string');
  if (badIndex !== -1) {
    throw new Error(`malicious-hosts: hosts[${badIndex}] must be a host string in ${resolved}`);
  }
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

function closeWatcherHandles(watcher) {
  if (!watcher) return;
  if (watcher.pending) clearTimeout(watcher.pending);
  if (watcher.kind === 'watchFile' && watcher.listener) {
    fs.unwatchFile(watcher.path, watcher.listener);
  }
  if (Array.isArray(watcher.handles)) {
    for (const handle of watcher.handles) {
      try {
        handle.close();
      } catch {}
    }
  } else if (watcher.handle) {
    try {
      watcher.handle.close();
    } catch {}
  }
}

function stopMaliciousHostsWatcher() {
  if (!activeWatcher) return;
  closeWatcherHandles(activeWatcher);
  activeWatcher = null;
}

function filenamesMatch(actual, expected) {
  if (actual == null) return true;
  const a = actual.toString();
  if (process.platform === 'win32') return a.toLowerCase() === expected.toLowerCase();
  return a === expected;
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

  const state = { kind: null, path: resolved, listener: null, handles: [], pending: null };

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

  function startWatchFileFallback() {
    if (state.kind === 'watchFile') return;
    closeWatcherHandles(state);
    state.handles = [];
    state.kind = 'watchFile';
    state.listener = () => scheduleReload();
    fs.watchFile(resolved, { interval: debounceMs }, state.listener);
    activeWatcher = state;
  }

  function watchTarget(targetFile) {
    const base = path.basename(targetFile);
    const handle = fs.watch(
      path.dirname(targetFile),
      { persistent: false },
      (eventType, filename) => {
        if (!filenamesMatch(filename, base)) return;
        if (eventType === 'change' || eventType === 'rename') scheduleReload();
      },
    );
    handle.on('error', (err) => {
      onError(err);
      try {
        startWatchFileFallback();
      } catch (fallbackErr) {
        onError(fallbackErr);
      }
    });
    return handle;
  }

  try {
    state.kind = 'watch';
    state.handles.push(watchTarget(watchPath));
    if (path.dirname(watchPath) !== path.dirname(resolved)) {
      state.handles.push(watchTarget(resolved));
    }
    activeWatcher = state;
  } catch {
    try {
      startWatchFileFallback();
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
    if (typeof suffix !== 'string') continue;
    const normalizedSuffix = normalizeHostEntry(suffix);
    if (normalizedSuffix && (host === normalizedSuffix || host.endsWith(`.${normalizedSuffix}`))) return suffix;
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
      archiveReason: null,
    };
  }
  if (emailHost) {
    return {
      hit: true,
      id: 'malicious_email_host',
      matchedHost: emailHost,
      archiveReason: null,
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
