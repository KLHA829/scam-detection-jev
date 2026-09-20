'use strict';

class TtlCache {
  constructor({ ttlMs = 900000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  _purge(ts) {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= ts) this.map.delete(key);
    }
  }

  get(key) {
    if (!this.ttlMs || !key) return undefined;
    const ts = this.now();
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= ts) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (!this.ttlMs || !key) return;
    const ts = this.now();
    this.map.set(key, { value, expiresAt: ts + this.ttlMs });
    if (this.map.size > 500) this._purge(ts);
  }
}

function cacheKeyForMessage(messageId, text) {
  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(String(text || ''), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${messageId || 'anon'}:${hash}`;
}

module.exports = {
  TtlCache,
  cacheKeyForMessage,
};
