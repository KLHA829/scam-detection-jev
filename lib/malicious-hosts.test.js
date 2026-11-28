'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  loadMaliciousHosts,
  reloadMaliciousHosts,
  resetMaliciousHostsCache,
  startMaliciousHostsWatcher,
  stopMaliciousHostsWatcher,
  hostMatchesMalicious,
  matchMaliciousHostInText,
  loadFeedHosts,
} = require('./malicious-hosts');
const { matchLinkScam } = require('./link-rules');
const { applyBlockPolicy } = require('./block-policy');
const { processIncomingMessage } = require('./handle-incoming');

describe('malicious host list', () => {
  it('preserves path and IPv6 list entries without widening host rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-host-forms-'));
    const file = path.join(dir, 'hosts.json');
    try {
      for (const [entry, body, expected] of [
        ['evil.com/some/path', 'https://evil.com/other', false],
        ['evil.com?query', 'https://evil.com/', false],
        ['evil.com#fragment', 'https://evil.com/', false],
        ['user@evil.com', 'https://evil.com/', false],
        ['evil.com:443', 'https://evil.com/', false],
        ['evil.com\\path', 'https://evil.com/', false],
        ['2001:db8::1', 'https://[2001:db8::1]/', true],
        ['[2001:db8::1]', 'https://[2001:db8::1]/', false],
        ['example.com', 'https://example.com/', true],
      ]) {
        fs.writeFileSync(file, JSON.stringify({ hosts: [entry] }));
        assert.deepEqual(reloadMaliciousHosts(file), [entry]);
        assert.equal(matchMaliciousHostInText(body, { dataPath: file }).hit, expected, entry);
        assert.equal(matchMaliciousHostInText(body, { hosts: [entry] }).hit, expected, entry);
      }
    } finally {
      resetMaliciousHostsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-string entries in explicitly supplied host lists', () => {
    const invalidHosts = [null, undefined, 42, true, {}, ['example.com']];
    assert.equal(hostMatchesMalicious('example.com', invalidHosts), null);
    assert.equal(matchMaliciousHostInText('https://example.com', { hosts: invalidHosts }).hit, false);
    assert.equal(hostMatchesMalicious('example.com', []), null);
    assert.equal(
      hostMatchesMalicious('例子.com', [...invalidHosts, 'xn--fsqu00a.com']),
      'xn--fsqu00a.com',
    );
  });

  for (const hostname of ['xn--fsqu00a.com', '例子.com']) {
    it(`matches IDN URLs spelled as ${hostname} against either list spelling`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-idn-'));
      const file = path.join(dir, 'hosts.json');
      const previousPath = process.env.MALICIOUS_HOSTS_PATH;
      try {
        process.env.MALICIOUS_HOSTS_PATH = file;
        for (const entry of ['xn--fsqu00a.com', '例子.com']) {
          fs.writeFileSync(file, JSON.stringify({ hosts: [entry] }));
          reloadMaliciousHosts(file);
          for (const prefix of ['', 'login.']) {
            const body = `https://${prefix}${hostname}/login`;
            assert.equal(matchLinkScam(body).id, 'malicious_host', body);
            assert.equal(matchMaliciousHostInText(body, { hosts: [entry] }).hit, true);
          }
          for (const body of ['', 'https://example.com', `https://${hostname}.evil.com`, 'https://xn--/']) {
            assert.equal(matchLinkScam(body).hit, false, body);
          }
        }
      } finally {
        if (previousPath === undefined) delete process.env.MALICIOUS_HOSTS_PATH;
        else process.env.MALICIOUS_HOSTS_PATH = previousPath;
        resetMaliciousHostsCache();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('matches exact host and subdomains from the data file', () => {
    const hosts = loadMaliciousHosts();
    assert.ok(hosts.includes('malicious-block-test.invalid'));
    assert.equal(hostMatchesMalicious('malicious-block-test.invalid', hosts), 'malicious-block-test.invalid');
    assert.equal(
      hostMatchesMalicious('login.malicious-block-test.invalid', hosts),
      'malicious-block-test.invalid',
    );
    assert.equal(hostMatchesMalicious('whatsapp.com', hosts), null);
  });

  it('ships curated hosts alongside the test placeholder', () => {
    const hosts = loadMaliciousHosts();
    assert.ok(hosts.includes('malicious-block-test.invalid'));
    assert.ok(hosts.includes('malware.testing.google.test'));
    assert.ok(hosts.includes('wicar.org'));
  });

  it('keeps the previous list when reload would wipe hosts to empty without MALICIOUS_HOSTS_ALLOW_EMPTY', () => {
    resetMaliciousHostsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-empty-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['keep-me.test'] }));
    try {
      reloadMaliciousHosts(file);
      fs.writeFileSync(file, JSON.stringify({ hosts: [] }));
      assert.deepEqual(reloadMaliciousHosts(file, {}), ['keep-me.test']);
      assert.equal(
        matchMaliciousHostInText('https://x.keep-me.test/a', { dataPath: file }).hit,
        true,
      );
      assert.deepEqual(reloadMaliciousHosts(file, { MALICIOUS_HOSTS_ALLOW_EMPTY: '1' }), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('reloadMaliciousHosts refreshes the in-process cache', () => {
    resetMaliciousHostsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-reload-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['first.test'] }));
    try {
      assert.deepEqual(reloadMaliciousHosts(file), ['first.test']);
      assert.equal(
        matchMaliciousHostInText('https://x.first.test/a', { dataPath: file }).hit,
        true,
      );
      fs.writeFileSync(file, JSON.stringify({ hosts: ['second.test'] }));
      assert.deepEqual(reloadMaliciousHosts(file), ['second.test']);
      assert.equal(
        matchMaliciousHostInText('https://x.first.test/a', { dataPath: file }).hit,
        false,
      );
      assert.equal(
        matchMaliciousHostInText('https://second.test/a', { dataPath: file }).hit,
        true,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('keeps the previous list when reload hits invalid JSON', () => {
    resetMaliciousHostsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-bad-json-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['stable.test'] }));
    try {
      reloadMaliciousHosts(file);
      fs.writeFileSync(file, '{ not-json');
      assert.throws(() => reloadMaliciousHosts(file), /cannot read/);
      assert.equal(
        matchMaliciousHostInText('https://pay.stable.test/x', { dataPath: file }).hit,
        true,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('keeps the previous list when reload hits a non-string host entry', () => {
    resetMaliciousHostsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-bad-entry-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['stable.test'] }));
    try {
      reloadMaliciousHosts(file);
      for (const bad of [{ host: 'evil.test' }, ['evil.test'], 42, null]) {
        fs.writeFileSync(file, JSON.stringify({ hosts: ['evil.test', bad] }));
        assert.throws(() => reloadMaliciousHosts(file), /hosts\[1\] must be a host string/);
        assert.deepEqual(loadMaliciousHosts(file), ['stable.test']);
        assert.equal(
          matchMaliciousHostInText('https://pay.stable.test/x', { dataPath: file }).hit,
          true,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('startMaliciousHostsWatcher reloads after the file changes', async () => {
    resetMaliciousHostsCache();
    stopMaliciousHostsWatcher();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-watch-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['before.test'] }));
    reloadMaliciousHosts(file);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('watch reload timeout')), 5000);
        startMaliciousHostsWatcher({
          dataPath: file,
          debounceMs: 80,
          onReload: (hosts) => {
            clearTimeout(timeout);
            try {
              assert.deepEqual(hosts, ['after.test']);
              assert.equal(
                matchMaliciousHostInText('https://after.test/x', { dataPath: file }).hit,
                true,
              );
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          onError: reject,
        });
        fs.writeFileSync(file, JSON.stringify({ hosts: ['after.test'] }));
      });
    } finally {
      stopMaliciousHostsWatcher();
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('startMaliciousHostsWatcher reloads repeated atomic saves and a subsequent in-place write', async () => {
    resetMaliciousHostsCache();
    stopMaliciousHostsWatcher();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-watch-atomic-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['before.test'] }));
    reloadMaliciousHosts(file);
    let pendingReload;
    startMaliciousHostsWatcher({
      dataPath: file,
      debounceMs: 20,
      onReload: (hosts) => pendingReload?.resolve(hosts),
      onError: (err) => pendingReload?.reject(err),
    });
    async function expectReload(host, atomic) {
      let timeout;
      try {
        const reloaded = new Promise((resolve, reject) => {
          pendingReload = { resolve, reject };
          timeout = setTimeout(() => reject(new Error(`watch reload timeout for ${host}`)), 3000);
        });
        const target = atomic ? path.join(dir, 'hosts.tmp') : file;
        fs.writeFileSync(target, JSON.stringify({ hosts: [host] }));
        if (atomic) fs.renameSync(target, file);
        assert.deepEqual(await reloaded, [host]);
        assert.deepEqual(loadMaliciousHosts(file), [host]);
      } finally {
        clearTimeout(timeout);
        pendingReload = null;
      }
    }
    try {
      await expectReload('first.test', true);
      await expectReload('second.test', true);
      await expectReload('in-place.test', false);
    } finally {
      stopMaliciousHostsWatcher();
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('startMaliciousHostsWatcher reloads atomic saves through a symlink in another directory', async () => {
    resetMaliciousHostsCache();
    stopMaliciousHostsWatcher();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-watch-symlink-'));
    const targetDir = path.join(dir, 'target');
    const linkDir = path.join(dir, 'link');
    fs.mkdirSync(targetDir);
    fs.mkdirSync(linkDir);
    let file = path.join(targetDir, 'hosts.json');
    let link = path.join(linkDir, 'blocklist.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ hosts: ['before.test'] }));
      try {
        fs.symlinkSync(file, link);
      } catch (err) {
        if (process.platform === 'win32' && err && err.code === 'EPERM') {
          const junctionDir = path.join(linkDir, 'target-junction');
          fs.symlinkSync(targetDir, junctionDir, 'junction');
          link = path.join(junctionDir, 'hosts.json');
        } else {
          throw err;
        }
      }
      reloadMaliciousHosts(link);
      let timeout;
      try {
        const reloaded = new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('symlink target reload timeout')), 3000);
          startMaliciousHostsWatcher({
            dataPath: link,
            debounceMs: 20,
            onReload: resolve,
            onError: reject,
          });
        });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ hosts: ['after.test'] }));
        fs.renameSync(`${file}.tmp`, file);
        assert.deepEqual(await reloaded, ['after.test']);
        assert.deepEqual(loadMaliciousHosts(link), ['after.test']);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      stopMaliciousHostsWatcher();
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('loads a custom JSON path', () => {
    resetMaliciousHostsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-hosts-'));
    const file = path.join(dir, 'hosts.json');
    fs.writeFileSync(file, JSON.stringify({ hosts: ['custom-bad.test'] }));
    try {
      const hosts = loadMaliciousHosts(file);
      assert.deepEqual(hosts, ['custom-bad.test']);
      assert.equal(
        matchMaliciousHostInText('https://x.custom-bad.test/a', { hosts }).id,
        'malicious_host',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetMaliciousHostsCache();
    }
  });

  it('archives via link rules and blocks only unsaved contacts through block policy', () => {
    const body = '請按 https://pay.malicious-block-test.invalid/now';
    assert.equal(matchLinkScam(body).id, 'malicious_host');
    const blocked = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: false,
        heuristic: matchLinkScam(body),
      },
    );
    assert.equal(blocked.action, 'block');
    assert.equal(blocked.blockReason, 'malicious_host');
    assert.equal(blocked.contactName, '封鎖·惡意域名');

    const saved = applyBlockPolicy(
      { action: 'archive', archiveReason: 'obvious_scam' },
      {
        savedContact: true,
        heuristic: matchLinkScam(body),
      },
    );
    assert.equal(saved.action, 'archive');
  });

  it('blocks an unsaved contact on a listed host after masked LLM confirmation', async () => {
    const { createStubJevlikeClient } = require('../stub-jevlike');
    const { llmChatResponse } = require('./test-llm');
    let blocked = false;
    const stub = createStubJevlikeClient('benign');
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '按此 https://malicious-block-test.invalid/login',
        chatId: 'mal@c.us',
        savedContact: false,
        messageId: 'mal-1',
      },
      {
        env: { LLM_REVIEW_COOLDOWN_MS: '0', LLM_REVIEW_MIN_CONFIDENCE: '0.7', BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH },
        maskClient: {
          async maskMessages(messages) {
            return stub.maskMessages(messages);
          },
        },
        llmReview: {
          enabled: true,
          apiUrl: 'http://llm.test/v1',
          fetchImpl: llmChatResponse({ action: 'block', strong: true, confidence: 0.95, reason: 'listed_host' }),
        },
        resolveNumber: async () => ({ digits: '85260009999', unresolvedLid: false }),
        archiveChat: async () => {},
        blockContact: async (info) => {
          blocked = info.contactName;
          return { renamed: true, blocked: true, muted: true, errors: [] };
        },
        recordBlock: async () => {},
      },
    );
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'malicious_host');
    assert.equal(blocked, '封鎖·惡意域名');
  });

  it('distinguishes blocklisted email addresses from links in the inbound handler', async (t) => {
    const { createStubJevlikeClient } = require('../stub-jevlike');
    const { llmChatResponse } = require('./test-llm');
    const cases = [
      ['archive', '電郵 help@hutong.biz'],
      ['archive', '電郵：ｈｅｌｐ＠ｈｕｔｏｎｇ．ｂｉｚ'],
      ['archive', '電郵 help@品牌.hutong.biz查詢'],
      ['archive', 'mailto:help@www.hutong.biz'],
      ['archive', 'www.support@hutong.biz'],
      ['archive', '"support desk"@hutong.biz'],
      ['archive', 'dev/test@hutong.biz'],
      ['archive', 'dev/?@hutong.biz'],
      ['ignore', 'hutong.biz@gmail.com'],
      ['ignore', 'www.hutong.biz@gmail.com'],
      ['ignore', 'www.example.org/reset?email=jane@example.org&return=https://hutong.biz'],
      ['block', 'help@hutong.biz https://hutong.biz'],
      ['block', 'https://hutong.biz help@hutong.biz'],
      ['block', 'help@hutong.biz https://wicar.org'],
      ['block', 'https://help@hutong.biz'],
      ['block', 'www.hutong.biz'],
      ['block', 'www.hutong.biz/reset?email=jane@example.org'],
      ['block', 'hutong.biz/users/jane@example.org'],
      ['block', 'hutong.biz'],
    ];
    for (const [action, body] of cases) {
      await t.test(`${action}: ${body}`, async () => {
        const effects = [];
        const out = await processIncomingMessage(
          { type: 'chat', body, chatId: 'mail@c.us', savedContact: false },
          {
            env: {
              CONTEXT_LLM_ENABLED: 'true',
              LLM_REVIEW_ENABLED: 'true',
              LLM_REVIEW_COOLDOWN_MS: '0',
              LLM_REVIEW_MIN_CONFIDENCE: '0.7',
              BLOCK_LOG_PATH: process.env.BLOCK_LOG_PATH,
            },
            maskClient: createStubJevlikeClient('benign'),
            llmReview: {
              enabled: true,
              apiUrl: 'http://llm.test/v1',
              fetchImpl: async (_url, opts) => {
                const sys = JSON.parse(opts.body).messages.find((m) => m.role === 'system').content;
                const listed = /confirmed malicious-host list/i.test(sys);
                return llmChatResponse(
                  listed
                    ? { action: 'archive', strong: true, confidence: 0.95, reason: 'listed_host' }
                    : { action: 'no_action', strong: false, confidence: 0.9, reason: 'benign' },
                )();
              },
            },
            archiveChat: async (reason) => { effects.push(`archive:${reason}`); },
            blockContact: async () => {
              effects.push('block');
              return { blocked: true, renamed: true, muted: true, errors: [] };
            },
            recordBlock: async () => { effects.push('record block'); },
          },
        );
        assert.equal(out.decision.action, action, JSON.stringify(effects));
        assert.deepEqual(effects, {
          archive: ['archive:context_llm'],
          block: ['block', 'archive:context_llm', 'record block'],
          ignore: [],
        }[action]);
      });
    }
  });

  it('rejects null or missing hosts payloads, normalizes trailing dots, and falls back on FSWatcher error', async () => {
    const { EventEmitter } = require('node:events');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-hardening-'));
    const file = path.join(dir, 'hosts.json');
    const prevPath = process.env.MALICIOUS_HOSTS_PATH;
    const origWatch = fs.watch;
    const origWatchFile = fs.watchFile;
    const origUnwatchFile = fs.unwatchFile;
    try {
      process.env.MALICIOUS_HOSTS_PATH = file;
      fs.writeFileSync(file, JSON.stringify({ hosts: ['evil.example.'] }));
      assert.deepEqual(reloadMaliciousHosts(file), ['evil.example']);
      assert.equal(matchMaliciousHostInText('https://evil.example/login', { dataPath: file }).hit, true);

      for (const badJson of ['null', '{}', '{"hosts":{}}']) {
        fs.writeFileSync(file, badJson);
        assert.throws(() => reloadMaliciousHosts(file));
        assert.deepEqual(loadMaliciousHosts(file), ['evil.example']);
      }

      fs.writeFileSync(file, JSON.stringify({ hosts: ['evil.example'] }));
      reloadMaliciousHosts(file);

      let emitter = null;
      let closed = false;
      let watchFileListener = null;
      fs.watch = () => {
        emitter = new EventEmitter();
        emitter.close = () => { closed = true; };
        return emitter;
      };
      fs.watchFile = (_target, _opts, fn) => {
        watchFileListener = fn;
        return {};
      };
      fs.unwatchFile = () => {
        watchFileListener = null;
      };

      const reloaded = [];
      const errors = [];
      const done = new Promise((resolve) => {
        startMaliciousHostsWatcher({
          dataPath: file,
          debounceMs: 10,
          onReload: (hosts) => {
            reloaded.push(hosts);
            resolve(hosts);
          },
          onError: (err) => errors.push(err),
        });
      });

      assert.ok(emitter);
      emitter.emit('error', new Error('ENOSPC'));
      assert.equal(closed, true);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /ENOSPC/);
      assert.equal(typeof watchFileListener, 'function');

      fs.writeFileSync(file, JSON.stringify({ hosts: ['fallback.example'] }));
      watchFileListener();
      const hosts = await done;
      assert.deepEqual(hosts, ['fallback.example']);
      assert.deepEqual(reloaded, [['fallback.example']]);
    } finally {
      fs.watch = origWatch;
      fs.watchFile = origWatchFile;
      fs.unwatchFile = origUnwatchFile;
      stopMaliciousHostsWatcher();
      if (prevPath === undefined) delete process.env.MALICIOUS_HOSTS_PATH;
      else process.env.MALICIOUS_HOSTS_PATH = prevPath;
      resetMaliciousHostsCache();
      loadMaliciousHosts();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('threat feed hosts (LLM signal only)', () => {
  function withFeed(hosts, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-hosts-'));
    const feedFile = path.join(dir, 'feed.json');
    if (hosts !== null) fs.writeFileSync(feedFile, JSON.stringify({ hosts }));
    const prev = process.env.MALICIOUS_FEED_HOSTS_PATH;
    process.env.MALICIOUS_FEED_HOSTS_PATH = feedFile;
    try {
      return fn(feedFile);
    } finally {
      if (prev == null) delete process.env.MALICIOUS_FEED_HOSTS_PATH;
      else process.env.MALICIOUS_FEED_HOSTS_PATH = prev;
      resetMaliciousHostsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('never merges into the curated blocklist', () => {
    withFeed(['feed-scam.example'], () => {
      const hosts = reloadMaliciousHosts(undefined, {});
      assert.ok(!hosts.includes('feed-scam.example'));
      assert.ok(hosts.includes('malicious-block-test.invalid'));
    });
  });

  it('loads feed hosts separately with exact and suffix matching', () => {
    const { loadFeedHosts, hostMatchesFeed } = require('./malicious-hosts');
    withFeed(['feed-scam.example'], (feedFile) => {
      const hosts = loadFeedHosts(feedFile);
      assert.deepEqual(hosts, ['feed-scam.example']);
      assert.equal(hostMatchesFeed('feed-scam.example', hosts), 'feed-scam.example');
      assert.equal(hostMatchesFeed('deep.sub.feed-scam.example', hosts), 'feed-scam.example');
      assert.equal(hostMatchesFeed('innocent.example', hosts), null);
    });
  });

  it('returns an empty list when the feed file is corrupt or missing', () => {
    const { loadFeedHosts } = require('./malicious-hosts');
    withFeed(null, (feedFile) => {
      assert.deepEqual(loadFeedHosts(feedFile), []);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-corrupt-'));
    const feedFile = path.join(dir, 'feed.json');
    fs.writeFileSync(feedFile, '{not json');
    const prev = process.env.MALICIOUS_FEED_HOSTS_PATH;
    process.env.MALICIOUS_FEED_HOSTS_PATH = feedFile;
    try {
      assert.deepEqual(loadFeedHosts(feedFile), []);
    } finally {
      if (prev == null) delete process.env.MALICIOUS_FEED_HOSTS_PATH;
      else process.env.MALICIOUS_FEED_HOSTS_PATH = prev;
      resetMaliciousHostsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('update-threat-feeds parser', () => {
  const { hostsFromPhishTank, parseCsvLine } = require('../scripts/update-threat-feeds');

  it('parses quoted CSV fields', () => {
    assert.deepEqual(parseCsvLine('1,"a,b","c""d",e'), ['1', 'a,b', 'c"d', 'e']);
    assert.deepEqual(parseCsvLine('1,2,3'), ['1', '2', '3']);
  });

  it('keeps only verified online hosts, newest first, deduped, no shared hosts', () => {
    const csv = [
      'phish_id,url,phish_detail_url,submission_time,verified,verification_time,online,target',
      '1,https://old.example/x,http://x,2026-01-01T00:00:00+00:00,yes,2026-01-01T01:00:00+00:00,yes,Other',
      '2,https://new.example/y,http://x,2026-06-01T00:00:00+00:00,yes,2026-06-01T01:00:00+00:00,yes,Other',
      '3,https://unverified.example/z,http://x,2026-07-01T00:00:00+00:00,no,2026-07-01T01:00:00+00:00,yes,Other',
      '4,https://offline.example/z,http://x,2026-07-01T00:00:00+00:00,yes,2026-07-01T01:00:00+00:00,no,Other',
      '5,https://new.example/other,http://x,2026-08-01T00:00:00+00:00,yes,2026-08-01T01:00:00+00:00,yes,Other',
      '6,https://github.io/evil,http://x,2026-09-01T00:00:00+00:00,yes,2026-09-01T01:00:00+00:00,yes,Other',
      '7,https://victim.github.io/evil,http://x,2026-09-02T00:00:00+00:00,yes,2026-09-02T01:00:00+00:00,yes,Other',
      '8,not a url,http://x,2026-09-03T00:00:00+00:00,yes,2026-09-03T01:00:00+00:00,yes,Other',
    ].join('\n');
    assert.deepEqual(hostsFromPhishTank(csv), ['victim.github.io', 'new.example', 'old.example']);
  });

  it('reloads feed hosts when the snapshot file changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-refresh-'));
    const feedFile = path.join(dir, 'feed.json');
    try {
      fs.writeFileSync(feedFile, JSON.stringify({ hosts: ['first-feed.example'] }));
      const prev = process.env.MALICIOUS_FEED_HOSTS_PATH;
      process.env.MALICIOUS_FEED_HOSTS_PATH = feedFile;
      resetMaliciousHostsCache();
      try {
        assert.deepEqual(loadFeedHosts(), ['first-feed.example']);
        fs.writeFileSync(feedFile, JSON.stringify({ hosts: ['second-feed.example'] }));
        // Same path, newer content: the refresh must take effect without a restart.
        fs.utimesSync(feedFile, new Date(), new Date(Date.now() + 5000));
        assert.deepEqual(loadFeedHosts(), ['second-feed.example']);
      } finally {
        if (prev == null) delete process.env.MALICIOUS_FEED_HOSTS_PATH;
        else process.env.MALICIOUS_FEED_HOSTS_PATH = prev;
        resetMaliciousHostsCache();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
