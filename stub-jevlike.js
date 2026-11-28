'use strict';

const http = require('http');
const { findMaskSpans } = require('./test/support/mask-spans-stub');

function createStubJevlikeClient() {
  return {
    async maskMessages(messages) {
      const list = Array.isArray(messages) ? messages : [];
      return {
        ok: true,
        model: 'stub-jevlike',
        method: 'identifier_spans',
        messages: list.map((text) => ({ spans: findMaskSpans(text) })),
      };
    },
  };
}

function startStubServer({ port = 8766 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'stub-jevlike', pii_mask: true }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/mask') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : typeof payload.text === 'string'
          ? [payload.text]
          : null;
      if (!messages || messages.length > 10 || messages.some((item) => typeof item !== 'string')) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'messages must be a list of at most 10 strings' }));
        return;
      }
      const client = createStubJevlikeClient();
      const json = await client.maskMessages(messages);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = {
  createStubJevlikeClient,
  startStubServer,
};

if (require.main === module) {
  const port = Number(process.env.JEVLIKE_PORT || 8766);
  startStubServer({ port }).then(() => {
    process.stderr.write(
      `[INFO] stub jevlike listening on http://127.0.0.1:${port}/v1/mask\n`,
    );
  });
}
