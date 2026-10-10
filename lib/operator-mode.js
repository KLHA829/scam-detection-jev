'use strict';

const fs = require('fs');
const path = require('path');

function defaultOperatorModePath(env = process.env) {
  if (env && env.OPERATOR_MODE_PATH) return env.OPERATOR_MODE_PATH;
  return path.join(process.cwd(), 'operator-mode.json');
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'auto' || mode === 'guided') return mode;
  return null;
}

function readOperatorModeFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeOperatorModeFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function resolveOperatorMode({ env = process.env, filePath } = {}) {
  const pinned = normalizeMode(env && env.OPERATOR_MODE);
  const stored = readOperatorModeFile(filePath || defaultOperatorModePath(env));
  if (pinned) {
    return {
      mode: pinned,
      needsSetup: false,
      pinned: true,
      setupPollId: stored && stored.setupPollId ? String(stored.setupPollId) : null,
      reconfigurePollId:
        stored && stored.reconfigurePollId ? String(stored.reconfigurePollId) : null,
    };
  }
  const saved = stored && normalizeMode(stored.mode);
  if (saved) {
    return {
      mode: saved,
      needsSetup: false,
      pinned: false,
      setupPollId: stored.setupPollId ? String(stored.setupPollId) : null,
      reconfigurePollId: stored.reconfigurePollId
        ? String(stored.reconfigurePollId)
        : null,
    };
  }
  return {
    mode: 'auto',
    needsSetup: true,
    pinned: false,
    setupPollId: stored && stored.setupPollId ? String(stored.setupPollId) : null,
    reconfigurePollId:
      stored && stored.reconfigurePollId ? String(stored.reconfigurePollId) : null,
  };
}

function createOperatorState({ env = process.env, filePath } = {}) {
  const pathName = filePath || defaultOperatorModePath(env);
  let snapshot = resolveOperatorMode({ env, filePath: pathName });

  function reload() {
    snapshot = resolveOperatorMode({ env, filePath: pathName });
    return snapshot;
  }

  function update(patch) {
    const current = readOperatorModeFile(pathName) || {};
    writeOperatorModeFile(pathName, { ...current, ...patch });
    return reload();
  }

  return {
    path: pathName,
    snapshot() {
      return { ...snapshot };
    },
    mode() {
      return snapshot.mode;
    },
    needsSetup() {
      return snapshot.needsSetup && !snapshot.setupPollId;
    },
    awaitingChoice() {
      return Boolean(snapshot.needsSetup);
    },
    pinned() {
      return snapshot.pinned;
    },
    setupPollId() {
      return snapshot.setupPollId;
    },
    reconfigurePollId() {
      return snapshot.reconfigurePollId;
    },
    isSetupPoll(id) {
      if (!id) return false;
      return id === snapshot.setupPollId || id === snapshot.reconfigurePollId;
    },
    rememberSetupPoll(id) {
      if (!id || snapshot.pinned) return snapshot;
      const patch = { setupPollId: String(id) };
      if (snapshot.needsSetup) patch.mode = null;
      return update(patch);
    },
    rememberReconfigurePoll(id) {
      if (!id || snapshot.pinned) return snapshot;
      return update({ reconfigurePollId: String(id) });
    },
    choose(mode) {
      const next = normalizeMode(mode);
      if (!next) throw new Error('invalid operator mode');
      if (snapshot.pinned) return snapshot;
      return update({
        mode: next,
        chosenAt: new Date().toISOString(),
        reconfigurePollId: null,
      });
    },
  };
}

module.exports = {
  defaultOperatorModePath,
  normalizeMode,
  readOperatorModeFile,
  resolveOperatorMode,
  createOperatorState,
};
