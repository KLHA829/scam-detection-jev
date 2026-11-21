'use strict';

const http = require('http');
const { findMaskSpans } = require('./test/support/mask-spans-stub');

const PRESETS = {
  benign: 0.04,
  not_scam: 0.04,
  scam: 0.96,
  mid: 0.55,
  unknown: 0.5,
  grey: 0.5,
  high: 0.92,
};

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function presetFromText(text, fallback = 'benign') {
  const body = String(text || '');
  const tagged = body.match(/\[stub:([a-z0-9_]+)\]/i);
  if (tagged && PRESETS[tagged[1].toLowerCase()] != null) {
    return tagged[1].toLowerCase();
  }
  return fallback;
}

function payloadFromProb(probScam, extra = {}) {
  const p = clamp01(probScam);
  const label = p >= 0.5 ? 'scam' : 'not_scam';
  return {
    ok: true,
    model: 'stub-jevlike',
    encoder: 'stub',
    label,
    prob_scam: p,
    prob_not_scam: Number((1 - p).toFixed(6)),
    score: Number((p * 100).toFixed(4)),
    options: ['not_scam', 'scam'],
    probabilities: [Number((1 - p).toFixed(6)), p],
    ...extra,
  };
}

function createStubJevlikeClient(presetOrFn = 'benign') {
  const client = {
    scorer: 'jevlike',
    async maskMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    return {
      ok: true,
      model: 'stub-jevlike',
      method: 'identifier_spans',
      messages: list.map((text) => ({ spans: findMaskSpans(text) })),
    };
  },
  async scoreText(text) {
      if (typeof presetOrFn === 'function') {
        const value = presetOrFn(text);
        const p = typeof value === 'number' ? value : PRESETS[value] ?? 0;
        return payloadFromProb(p);
      }
      if (typeof presetOrFn === 'number') {
        return payloadFromProb(presetOrFn);
      }
      const key = presetFromText(text, presetOrFn);
      return payloadFromProb(PRESETS[key] ?? PRESETS.benign);
    },
  };
  return client;
}

function createStubJevlikeFetch(presetOrFn = 'benign') {
  return async (_url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const client = createStubJevlikeClient(presetOrFn);
    const json = await client.scoreText(body.text || body.context || '');
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function startStubServer({ port = 8766, preset = 'benign' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'stub-jevlike' }));
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
      const client = createStubJevlikeClient(preset);
      const json = await client.maskMessages(messages);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
      return;
    }
    if (
      req.method === 'POST' &&
      (url.pathname === '/v1/score' || url.pathname === '/score' || url.pathname === '/predict')
    ) {
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
      const client = createStubJevlikeClient(preset);
      const json = await client.scoreText(payload.text || payload.context || '');
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
  PRESETS,
  payloadFromProb,
  createStubJevlikeClient,
  createStubJevlikeFetch,
  startStubServer,
};

if (require.main === module) {
  const port = Number(process.env.JEVLIKE_PORT || 8766);
  startStubServer({ port }).then(() => {
    process.stderr.write(
      `[INFO] stub jevlike listening on http://127.0.0.1:${port}/v1/mask (lab /v1/score also served)\n`,
    );
  });
}
