'use strict';

const http = require('http');
const { questionsToRecords, resultsToAnswers } = require('./lib/lightjev-client');

const DEFAULT_NOULS = {
  money: 0.05,
  banking: 0.04,
  login_ato: 0.03,
  impersonation: 0.04,
  credential_harvest: 0.02,
  parcel_customs: 0.02,
  prize_job: 0.03,
  crypto_romance: 0.02,
  link_lure: 0.04,
  urgency: 0.05,
};

const PRESETS = {
  benign: { ...DEFAULT_NOULS },
  not_scam: { ...DEFAULT_NOULS },
  scam: {
    money: 0.96,
    banking: 0.91,
    login_ato: 0.94,
    impersonation: 0.9,
    credential_harvest: 0.2,
    parcel_customs: 0.1,
    prize_job: 0.08,
    crypto_romance: 0.1,
    link_lure: 0.7,
    urgency: 0.88,
  },
  mid: {
    money: 0.62,
    banking: 0.2,
    login_ato: 0.18,
    impersonation: 0.2,
    credential_harvest: 0.1,
    parcel_customs: 0.1,
    prize_job: 0.12,
    crypto_romance: 0.1,
    link_lure: 0.5,
    urgency: 0.7,
  },
  unknown: {
    money: 0.55,
    banking: 0.5,
    login_ato: 0.2,
    impersonation: 0.2,
    credential_harvest: 0.1,
    parcel_customs: 0.1,
    prize_job: 0.15,
    crypto_romance: 0.1,
    link_lure: 0.2,
    urgency: 0.55,
  },
};

function noulMapToAnswers(noulMap) {
  const answers = {};
  for (const [id, noul] of Object.entries(noulMap)) {
    answers[id] = { type: 'noul', noul };
  }
  return answers;
}

function noulMapToLightJevResults(noulMap) {
  return Object.entries(noulMap).map(([id, noul]) => ({
    id,
    kind: 'boolean',
    candidates: ['false', 'true'],
    probabilities: [Number((1 - noul).toFixed(6)), noul],
    selected: noul >= 0.5 ? 'true' : 'false',
    selected_index: noul >= 0.5 ? 1 : 0,
    temperature: 1,
  }));
}

function wrapResponse(answers, model = 'stub-lightjev') {
  return {
    model,
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function presetFromState(state) {
  const text =
    typeof state === 'string' ? state : JSON.stringify(state || '');
  const match = text.match(/\[stub:(benign|not_scam|scam|mid|unknown)\]/i);
  if (match) {
    const key = match[1].toLowerCase();
    if (key === 'not_scam') return PRESETS.benign;
    return PRESETS[key] || PRESETS.benign;
  }
  return PRESETS.benign;
}

function mapForRequest(presetOrFn, body) {
  if (typeof presetOrFn === 'function') return presetOrFn(body);
  if (presetOrFn === 'from-state') {
    const state =
      (body && body.state) ||
      (body && body.records && body.records[0] && body.records[0].state);
    return presetFromState(state);
  }
  return PRESETS[presetOrFn] || PRESETS.benign;
}

function createStubClient(presetOrFn = 'benign') {
  return {
    async systemOne({ state } = {}) {
      let map;
      if (typeof presetOrFn === 'function') {
        map = presetOrFn({ state });
      } else if (presetOrFn === 'from-state') {
        map = presetFromState(state);
      } else {
        map = PRESETS[presetOrFn] || PRESETS.benign;
      }
      return noulMapToAnswers(map);
    },
  };
}

function createStubFetch(presetOrFn = 'from-state') {
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const map = mapForRequest(presetOrFn, body);
    const path = String(url);
    let payload;
    if (path.includes('/predict')) {
      payload = { model: 'stub-lightjev', results: noulMapToLightJevResults(map) };
    } else {
      payload = wrapResponse(noulMapToAnswers(map));
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function createStubServer({ port = 8765, preset = 'from-state' } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'stub-lightjev' }));
      return;
    }
    const path = String(req.url || '');
    if (req.method !== 'POST' || !(path.includes('/predict') || path.includes('/v1/systemone'))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    const map = mapForRequest(preset, body);
    const payload = path.includes('/predict')
      ? { model: 'stub-lightjev', results: noulMapToLightJevResults(map) }
      : wrapResponse(noulMapToAnswers(map));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const port = Number(process.env.STUB_LIGHTJEV_PORT || process.env.LIGHTJEV_PORT || 8765);
  const server = await createStubServer({ port, preset: 'from-state' });
  console.log(`[INFO] stub LightJev listening on http://127.0.0.1:${port}/predict`);
  return server;
}

module.exports = {
  DEFAULT_NOULS,
  PRESETS,
  noulMapToAnswers,
  noulMapToLightJevResults,
  wrapResponse,
  presetFromState,
  createStubClient,
  createStubFetch,
  createStubServer,
  questionsToRecords,
  resultsToAnswers,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
