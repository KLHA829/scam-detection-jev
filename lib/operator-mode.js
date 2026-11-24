// @ts-check
'use strict';

const path = require('path');
const { readJsonFile, writeJsonFileAtomic } = require('./json-store');

function defaultOperatorModePath(env = process.env) {
  if (env && env.OPERATOR_MODE_PATH) return env.OPERATOR_MODE_PATH;
  return path.join(process.cwd(), 'operator-mode.json');
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'auto' || mode === 'guided') return mode;
  return null;
}

function readOperatorModeState(filePath) {
  const res = readJsonFile(filePath);
  if (!res.ok) {
    return { data: null, transientError: Boolean(res.transient) };
  }
  const raw = res.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, transientError: false };
  }
  return { data: raw, transientError: false };
}

function readOperatorModeFile(filePath) {
  return readOperatorModeState(filePath).data;
}

function writeOperatorModeFile(filePath, data) {
  writeJsonFileAtomic(filePath, data);
}

/** @param {{ env?: NodeJS.ProcessEnv, filePath?: string | null }} [options] */
function resolveOperatorMode({ env = process.env, filePath = null } = {}) {
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

/** @param {{ env?: NodeJS.ProcessEnv, filePath?: string | null }} [options] */
function createOperatorState({ env = process.env, filePath = null } = {}) {
  const pathName = filePath || defaultOperatorModePath(env);
  let snapshot = resolveOperatorMode({ env, filePath: pathName });

  function reload() {
    snapshot = resolveOperatorMode({ env, filePath: pathName });
    return snapshot;
  }

  function update(patch) {
    const read = readOperatorModeState(pathName);
    if (read.transientError) {
      throw new Error('refusing to overwrite operator mode after transient read failure');
    }
    const base = read.data || (snapshot.needsSetup ? {} : {
      mode: snapshot.mode,
      setupPollId: snapshot.setupPollId,
      reconfigurePollId: snapshot.reconfigurePollId,
    });
    writeOperatorModeFile(pathName, { ...base, ...patch });
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
      return id === (snapshot.reconfigurePollId || snapshot.setupPollId);
    },
    rememberSetupPoll(id) {
      if (!id || snapshot.pinned) return snapshot;
      const patch = { setupPollId: String(id), reconfigurePollId: null };
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
