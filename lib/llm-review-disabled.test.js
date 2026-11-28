'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { processIncomingMessage } = require('./handle-incoming');
const { createLlmReviewConfig } = require('./llm-review');
const { createStubJevlikeClient } = require('../stub-jevlike');

it('disabled review skips the chat API and fails closed on every message including curated hosts', async (t) => {
  let requests = 0;
  let archives = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ action: 'archive', confidence: 0.99, reason: 'test' }),
    } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    LLM_REVIEW_ENABLED: 'false',
    LLM_REVIEW_COOLDOWN_MS: '0',
    LLM_REVIEW_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const deps = {
    env,
    llmReview: createLlmReviewConfig(env),
    maskClient: createStubJevlikeClient(),
    archiveChat: async () => { archives += 1; },
  };
  const result = await processIncomingMessage({
    type: 'chat', body: '高回報投資，加我了解', chatId: 'disabled@c.us', savedContact: false,
  }, deps);
  assert.equal(requests, 0, 'disabled review must not send chat-API requests');
  assert.equal(archives, 0);
  assert.equal(result.decision.action, 'ignore');
  assert.equal(result.llmTrigger.skipped, 'disabled');

  const keywordHit = await processIncomingMessage({
    type: 'chat', body: 'https://hsbc.evil.com', chatId: 'lookalike@c.us', savedContact: false,
  }, deps);
  assert.equal(keywordHit.heuristic.id, 'lookalike_domain');
  assert.equal(keywordHit.decision.action, 'ignore');
  assert.equal(archives, 0);

  const hardHit = await processIncomingMessage({
    type: 'chat', body: 'https://malicious-block-test.invalid/login', chatId: 'link@c.us', savedContact: true,
  }, deps);
  assert.equal(hardHit.heuristic.id, 'malicious_host');
  assert.equal(hardHit.decision.action, 'ignore');
  assert.equal(hardHit.llmTrigger.skipped, 'disabled');
  assert.equal(archives, 0);
  const emailHit = await processIncomingMessage({
    type: 'chat', body: '電郵 help@hutong.biz', chatId: 'email@c.us', savedContact: false,
  }, deps);
  assert.equal(emailHit.heuristic.id, 'malicious_email_host');
  assert.equal(emailHit.decision.action, 'ignore');
  assert.equal(emailHit.llmTrigger.skipped, 'disabled');
  assert.equal(archives, 0);
  assert.equal(requests, 0);
});
