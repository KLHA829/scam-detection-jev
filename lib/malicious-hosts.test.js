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
} = require('./malicious-hosts');
const { matchLinkScam } = require('./link-rules');
const { applyBlockPolicy } = require('./block-policy');
const { processIncomingMessage } = require('./handle-incoming');
const { loadRubric } = require('./score-message');

const rubric = loadRubric();

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
    const file = path.join(targetDir, 'hosts.json');
    const link = path.join(linkDir, 'blocklist.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ hosts: ['before.test'] }));
      fs.symlinkSync(file, link);
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
        scoreResult: { score: 3, label: 'not_scam', ok: true, thresholds: rubric.thresholds },
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
        scoreResult: { score: 3, label: 'not_scam', ok: true, thresholds: rubric.thresholds },
        heuristic: matchLinkScam(body),
      },
    );
    assert.equal(saved.action, 'archive');
  });

  it('blocks an unsaved contact on a listed host without waiting for the scorer', async () => {
    let scoreCalls = 0;
    let blocked = false;
    const out = await processIncomingMessage(
      {
        type: 'chat',
        body: '按此 https://malicious-block-test.invalid/login',
        chatId: 'mal@c.us',
        savedContact: false,
        messageId: 'mal-1',
      },
      {
        maskClient: {
          async scoreText() {
            scoreCalls += 1;
            return new Promise(() => {});
          },
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
    assert.equal(scoreCalls, 0);
    assert.equal(out.decision.action, 'block');
    assert.equal(out.decision.blockReason, 'malicious_host');
    assert.equal(blocked, '封鎖·惡意域名');
  });

  it('distinguishes blocklisted email addresses from links in the inbound handler', async (t) => {
    const cases = [
      ['review', '電郵 help@hutong.biz'],
      ['review', '電郵：ｈｅｌｐ＠ｈｕｔｏｎｇ．ｂｉｚ'],
      ['review', '電郵 help@品牌.hutong.biz查詢'],
      ['review', 'mailto:help@www.hutong.biz'],
      ['review', 'www.support@hutong.biz'],
      ['review', '"support desk"@hutong.biz'],
      ['review', 'dev/test@hutong.biz'],
      ['review', 'dev/?@hutong.biz'],
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
            env: { LLM_REVIEW_ENABLED: 'false' },
            archiveChat: async (reason) => { effects.push(`archive:${reason}`); },
            blockContact: async () => {
              effects.push('block');
              return { blocked: true, renamed: true, muted: true, errors: [] };
            },
            recordBlock: async () => { effects.push('record block'); },
          },
        );
        assert.equal(out.decision.action, action === 'review' ? 'ignore' : action, JSON.stringify(effects));
        if (action === 'review') assert.equal(out.heuristic.id, 'malicious_email_host');
        assert.deepEqual(effects, {
          review: [],
          block: ['block', 'archive:obvious_scam', 'record block'],
          ignore: [],
        }[action]);
      });
    }
  });
});
