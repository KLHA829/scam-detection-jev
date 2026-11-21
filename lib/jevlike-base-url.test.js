'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMaskClient, resolveMaskUrl, resolveScoreUrl } = require('./jevlike-client');
const { processIncomingMessage } = require('./handle-incoming');

test('full mask endpoint reaches review through the real inbound handler', async (t) => {
  const paths = [];
  let reviews = 0;
  const server = http.createServer(async (req, res) => {
    paths.push(req.url);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/mask') {
      res.end(JSON.stringify({ messages: body.messages.map(() => ({ spans: [] })) }));
    } else if (req.url === '/v1/chat/completions') {
      reviews += 1;
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'no_action', confidence: 0.99, reason: 'benign' }) } }] }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ['/v1/mask', '/v1/mask/']) {
    const env = { JEVLIKE_BASE_URL: base + suffix, LLM_REVIEW_ENABLED: 'true', LLM_REVIEW_COOLDOWN_MS: '0' };
    const result = await processIncomingMessage({
      body: '今晚飲茶？', chatId: '85291234567@c.us', type: 'chat', savedContact: true,
    }, {
      env, maskClient: createMaskClient(env),
      llmReview: { enabled: true, apiUrl: base + '/v1/chat/completions' },
    });
    console.log(JSON.stringify({ configuredPath: suffix, paths: paths.map(String), reviews, skipped: result.llmTrigger.skipped || null, action: result.decision.action }));
    assert.equal(result.llmTrigger.skipped, null);
    assert.equal(result.llmReview.ok, true);
  }
  assert.equal(reviews, 2);
});

test('endpoint resolution normalizes shared mask bases and preserves score aliases', () => {
  const base = 'http://127.0.0.1:8765/prefix';
  for (const suffix of ['', '/', '///', '/v1/mask', '/v1/mask/', '/v1/mask///']) {
    assert.equal(resolveMaskUrl(base + suffix), base + '/v1/mask');
    assert.equal(resolveScoreUrl(base + suffix), base + '/v1/score');
  }
  for (const suffix of ['/v1/score', '/score', '/predict']) {
    assert.equal(resolveScoreUrl(base + suffix + '///'), base + suffix);
    assert.equal(resolveMaskUrl(base + suffix + '///'), base + '/v1/mask');
  }
  for (const prefix of ['/score', '/predict']) {
    for (const trailing of ['', '/', '///']) {
      assert.equal(resolveMaskUrl(base + prefix + '/v1/mask' + trailing), base + prefix + '/v1/mask');
      assert.equal(resolveScoreUrl(base + prefix + '/v1/mask' + trailing), base + prefix + '/v1/score');
    }
  }
  for (const empty of ['', undefined, null]) {
    assert.equal(resolveMaskUrl(empty), 'http://127.0.0.1:8766/v1/mask');
    assert.equal(resolveScoreUrl(empty), 'http://127.0.0.1:8766/v1/score');
  }
});
