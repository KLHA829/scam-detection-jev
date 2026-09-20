'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_URL,
  DEFAULT_THRESH,
  classifierEnabled,
  classifierThreshold,
  looksZhYue,
  resolveScoreUrl,
  scoreLocalClassifier,
} = require('./local-classifier-client');

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ZH_TEXT = '細佬幫我轉數快三千';

describe('local classifier client', () => {
  it('is disabled unless SCAM_CLASSIFIER_ENABLED is set', async () => {
    let called = 0;
    const out = await scoreLocalClassifier(ZH_TEXT, {
      env: {},
      fetchImpl: async () => {
        called += 1;
        return jsonResponse({ label: 'scam', prob_scam: 0.99 });
      },
    });
    assert.equal(classifierEnabled({}), false);
    assert.equal(called, 0);
    assert.equal(out.hit, false);
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'disabled');
  });

  it('defaults threshold to 0.85', () => {
    assert.equal(classifierThreshold({}), DEFAULT_THRESH);
    assert.equal(classifierThreshold({ SCAM_CLASSIFIER_THRESH: '0.9' }), 0.9);
  });

  it('detects zh/yue CJK and skips English-only text', async () => {
    assert.equal(looksZhYue('今晚食飯嗎'), true);
    assert.equal(looksZhYue('海关扣留您的包裹'), true);
    assert.equal(looksZhYue('Client meeting postponed to Friday.'), false);

    let called = 0;
    const out = await scoreLocalClassifier('hello there', {
      env: { SCAM_CLASSIFIER_ENABLED: 'true' },
      fetchImpl: async () => {
        called += 1;
        return jsonResponse({ label: 'scam', prob_scam: 0.99 });
      },
    });
    assert.equal(called, 0);
    assert.equal(out.reason, 'not_zh_yue');
    assert.equal(out.hit, false);
  });

  it('POSTs {text} and hits when prob_scam >= thresh', async () => {
    let request = null;
    const out = await scoreLocalClassifier(ZH_TEXT, {
      env: {
        SCAM_CLASSIFIER_ENABLED: '1',
        SCAM_CLASSIFIER_THRESH: '0.85',
        SCAM_CLASSIFIER_URL: 'http://127.0.0.1:8099',
      },
      fetchImpl: async (url, opts) => {
        request = { url, opts };
        return jsonResponse({ label: 'scam', prob_scam: 0.9912, prob_not_scam: 0.0088 });
      },
    });
    assert.equal(request.url, 'http://127.0.0.1:8099/v1/score');
    assert.equal(request.opts.method, 'POST');
    assert.deepEqual(JSON.parse(request.opts.body), { text: ZH_TEXT });
    assert.equal(out.ok, true);
    assert.equal(out.hit, true);
    assert.equal(out.prob_scam, 0.9912);
    assert.equal(out.archiveReason, 'local_classifier_scam');
  });

  it('does not hit when probability is below the bot threshold', async () => {
    const out = await scoreLocalClassifier(ZH_TEXT, {
      env: { SCAM_CLASSIFIER_ENABLED: 'true', SCAM_CLASSIFIER_THRESH: '0.85' },
      fetchImpl: async () =>
        jsonResponse({ label: 'scam', prob_scam: 0.5832 }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.hit, false);
    assert.equal(out.archiveReason, null);
    assert.equal(out.prob_scam, 0.5832);
  });

  it('resolves default and bare-host URLs to /v1/score', () => {
    assert.equal(resolveScoreUrl(undefined, {}), DEFAULT_URL);
    assert.equal(resolveScoreUrl('http://gpu-pc:8099'), 'http://gpu-pc:8099/v1/score');
    assert.equal(
      resolveScoreUrl('http://gpu-pc:8099/v1/score'),
      'http://gpu-pc:8099/v1/score',
    );
  });

  it('fails open on timeout, 5xx, and invalid JSON', async () => {
    const timeout = await scoreLocalClassifier(ZH_TEXT, {
      env: { SCAM_CLASSIFIER_ENABLED: 'true' },
      timeoutMs: 20,
      fetchImpl: async (_url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    assert.equal(timeout.hit, false);
    assert.equal(timeout.ok, false);
    assert.equal(timeout.reason, 'timeout');

    const httpErr = await scoreLocalClassifier(ZH_TEXT, {
      env: { SCAM_CLASSIFIER_ENABLED: 'true' },
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    assert.equal(httpErr.hit, false);
    assert.equal(httpErr.ok, false);
    assert.equal(httpErr.reason, 'http_error');

    const bad = await scoreLocalClassifier(ZH_TEXT, {
      env: { SCAM_CLASSIFIER_ENABLED: 'true' },
      fetchImpl: async () =>
        new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    assert.equal(bad.hit, false);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'invalid_response');
  });

  it('fails open when fetch throws (server down)', async () => {
    const out = await scoreLocalClassifier(ZH_TEXT, {
      env: { SCAM_CLASSIFIER_ENABLED: 'true' },
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(out.hit, false);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'error');
    assert.match(out.error, /ECONNREFUSED/);
  });
});
