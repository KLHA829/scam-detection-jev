// @ts-check
'use strict';

const DEFAULT_GAP_MS = 3000;

function envInt(env, key, fallback) {
  if (!env || env[key] == null || env[key] === '') return fallback;
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function createActionPacer({
  env = process.env,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const gapMs = envInt(env, 'WA_ACTION_GAP_MS', DEFAULT_GAP_MS);
  let lastAt = 0;
  let chain = Promise.resolve();

  async function pause() {
    if (gapMs <= 0) return;
    const t = now();
    if (lastAt !== 0) {
      const wait = lastAt + gapMs - t;
      if (wait > 0) await sleep(wait);
    }
    lastAt = now();
  }

  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    pause,
    exclusive,
    gapMs,
  };
}

module.exports = {
  DEFAULT_GAP_MS,
  createActionPacer,
};
