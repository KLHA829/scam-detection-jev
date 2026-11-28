'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { matchLinkScam } = require('./link-rules');
const { resetMaliciousHostsCache } = require('./malicious-hosts');
const { reviewOpeningMessages } = require('./context-llm');

function withFeedHosts(hosts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-signal-'));
  const feedFile = path.join(dir, 'feed.json');
  fs.writeFileSync(feedFile, JSON.stringify({ hosts }));
  const prev = process.env.MALICIOUS_FEED_HOSTS_PATH;
  process.env.MALICIOUS_FEED_HOSTS_PATH = feedFile;
  resetMaliciousHostsCache();
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        (value) => {
          cleanup();
          return value;
        },
        (err) => {
          cleanup();
          throw err;
        },
      );
    }
    cleanup();
    return out;
  } catch (err) {
    cleanup();
    throw err;
  }

  function cleanup() {
    if (prev == null) delete process.env.MALICIOUS_FEED_HOSTS_PATH;
    else process.env.MALICIOUS_FEED_HOSTS_PATH = prev;
    resetMaliciousHostsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('threat feed as an LLM signal', () => {
  it('hits review-only and never archives or blocks by itself', () => {
    withFeedHosts(['feed-scam.example'], () => {
      const out = matchLinkScam('撳呢度 https://feed-scam.example/login');
      assert.equal(out.hit, true);
      assert.equal(out.id, 'threat_feed_host');
      assert.equal(out.matchedHost, 'feed-scam.example');
      assert.equal(out.archiveReason, null);
      const { isDirectArchiveHit } = require('./link-rules');
      assert.equal(isDirectArchiveHit(out), false);
    });
  });

  it('does not hit for clean or absent feeds', () => {
    withFeedHosts(['feed-scam.example'], () => {
      assert.equal(matchLinkScam('去 https://innocent.example/').id, null);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-missing-'));
    const prev = process.env.MALICIOUS_FEED_HOSTS_PATH;
    process.env.MALICIOUS_FEED_HOSTS_PATH = path.join(dir, 'nope.json');
    resetMaliciousHostsCache();
    try {
      assert.equal(matchLinkScam('撳呢度 https://feed-scam.example/login').id, null);
    } finally {
      if (prev == null) delete process.env.MALICIOUS_FEED_HOSTS_PATH;
      else process.env.MALICIOUS_FEED_HOSTS_PATH = prev;
      resetMaliciousHostsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never preempts the curated malicious-host hard hit', () => {
    withFeedHosts(['malicious-block-test.invalid'], () => {
      const out = matchLinkScam('https://malicious-block-test.invalid/x');
      assert.equal(out.id, 'malicious_host');
    });
  });

  it('annotates the context review system prompt with the line number', async () => {
    await withFeedHosts(['feed-scam.example'], async () => {
      let sent = null;
      const out = await reviewOpeningMessages({
        turns: [
          { fromMe: false, body: '你好' },
          { fromMe: false, body: '撳呢度 https://feed-scam.example/login 登入' },
        ],
        maskClient: {
          maskMessages: async (bodies) => ({ messages: bodies.map(() => ({ spans: [] })) }),
        },
        llmOptions: {
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            sent = JSON.parse(opts.body);
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: '{"action":"archive","confidence":0.9,"reason":"feed"}' } }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
        env: {},
      });
      assert.equal(out.llmReview.action, 'archive');
      const system = sent.messages.find((m) => m.role === 'system').content;
      assert.match(system, /message \[2\] leads to a host on the PhishTank verified phishing feed/);
      assert.match(system, /warning about it rather than the scam itself/);
      assert.equal(system.includes('feed-scam.example'), false);
    });
  });

  it('annotates nothing when no turn hits the feed', async () => {
    await withFeedHosts(['feed-scam.example'], async () => {
      let sent = null;
      await reviewOpeningMessages({
        turns: [{ fromMe: false, body: '普通對話' }],
        maskClient: {
          maskMessages: async (bodies) => ({ messages: bodies.map(() => ({ spans: [] })) }),
        },
        llmOptions: {
          apiUrl: 'http://llm.test/v1',
          fetchImpl: async (_url, opts) => {
            sent = JSON.parse(opts.body);
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: '{"action":"no_action","confidence":0.9,"reason":"ok"}' } }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
        env: {},
      });
      const system = sent.messages.find((m) => m.role === 'system').content;
      assert.equal(system.includes('PhishTank'), false);
    });
  });
});
