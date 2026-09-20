'use strict';

class LightJevError extends Error {
  constructor(status, bodyText) {
    super(
      `LightJev HTTP ${status}${bodyText ? `: ${String(bodyText).slice(0, 200)}` : ''}`,
    );
    this.name = 'LightJevError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instructionText(question) {
  if (question == null) return '';
  if (typeof question === 'string') return question.trim();
  if (typeof question.instructions === 'string') {
    return question.instructions.trim();
  }
  if (question.instructions != null) {
    return JSON.stringify(question.instructions);
  }
  return '';
}

function questionsToRecords(state, questions, groupId = 'message') {
  const records = [];
  const stateText =
    typeof state === 'string' ? state : JSON.stringify(state ?? '');
  for (const [id, question] of Object.entries(questions || {})) {
    const type = (question && question.type) || 'noul';
    const text = instructionText(question);
    if (!text) {
      throw new Error(`LightJev question "${id}" is missing instructions`);
    }
    if (type === 'noul' || type === 'boolean') {
      records.push({
        id,
        group_id: groupId,
        state: stateText,
        question: text,
        kind: 'boolean',
        candidates: ['false', 'true'],
      });
      continue;
    }
    if (type === 'choice') {
      const criteria = (question && question.criteria) || {};
      const candidates = Object.keys(criteria).map((key) => {
        const desc = criteria[key];
        if (desc == null || desc === '') return key;
        return `${key}: ${desc}`;
      });
      if (candidates.length < 2) {
        throw new Error(`LightJev choice "${id}" needs at least 2 options`);
      }
      records.push({
        id,
        group_id: groupId,
        state: stateText,
        question: text,
        kind: 'choice',
        candidates,
      });
      continue;
    }
    if (type === 'score') {
      const candidates = question && question.criteria;
      if (!Array.isArray(candidates) || candidates.length < 2) {
        throw new Error(`LightJev score "${id}" needs an ordered criteria list`);
      }
      records.push({
        id,
        group_id: groupId,
        state: stateText,
        question: text,
        kind: 'score',
        candidates,
      });
      continue;
    }
    throw new Error(`unsupported LightJev question type: ${type}`);
  }
  if (records.length === 0) {
    throw new Error('LightJev questions are required');
  }
  return records;
}

function resultsToAnswers(results) {
  if (!Array.isArray(results)) {
    throw new Error('invalid LightJev response');
  }
  const answers = {};
  for (const row of results) {
    if (!row || !row.id) {
      throw new Error('invalid LightJev response');
    }
    if (row.kind === 'boolean') {
      const probs = row.probabilities;
      if (!Array.isArray(probs) || probs.length < 2) {
        throw new Error('invalid LightJev boolean probabilities');
      }
      answers[row.id] = { type: 'noul', noul: Number(probs[1]) };
      continue;
    }
    if (row.kind === 'choice') {
      const probs = {};
      (row.candidates || []).forEach((name, i) => {
        probs[name] = row.probabilities ? row.probabilities[i] : undefined;
      });
      answers[row.id] = {
        type: 'choice',
        choice: row.selected,
        probabilities: probs,
      };
      continue;
    }
    if (row.kind === 'score') {
      const probs = {};
      (row.candidates || []).forEach((_, i) => {
        probs[String(i)] = row.probabilities ? row.probabilities[i] : undefined;
      });
      answers[row.id] = {
        type: 'score',
        score: row.expectation,
        probabilities: probs,
      };
      continue;
    }
    throw new Error(`unsupported LightJev result kind: ${row.kind}`);
  }
  if (Object.keys(answers).length === 0) {
    throw new Error('invalid LightJev response');
  }
  return answers;
}

class LightJevClient {
  constructor({
    baseURL,
    apiKey,
    timeoutMs,
    fetchImpl,
  } = {}) {
    const env = process.env;
    this.baseURL = String(
      baseURL ||
        env.LIGHTJEV_BASE_URL ||
        env.OPENJEV_BASE_URL ||
        'http://127.0.0.1:8765',
    ).replace(/\/$/, '');
    this.apiKey =
      apiKey ?? env.LIGHTJEV_API_KEY ?? env.OPENJEV_API_KEY ?? '';
    this.timeoutMs = Number(
      timeoutMs ?? env.LIGHTJEV_TIMEOUT_MS ?? env.OPENJEV_TIMEOUT_MS ?? 30000,
    );
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
  }

  async _post(url, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { ok: res.ok, status: res.status, json, bodyText: text };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('LightJev timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async systemOne({ state, questions, groupId } = {}) {
    const records = questionsToRecords(state, questions, groupId || 'message');
    const url = `${this.baseURL}/predict`;

    let lastRetryError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this._post(url, { records });
      if (res.status === 429 || res.status === 529) {
        lastRetryError = new LightJevError(res.status, res.bodyText);
        if (attempt === 0) await sleep(200);
        continue;
      }
      if (!res.ok) {
        throw new LightJevError(res.status, res.bodyText);
      }
      if (!res.json) {
        throw new Error('invalid LightJev response');
      }
      const results = Array.isArray(res.json)
        ? res.json
        : res.json.results;
      return resultsToAnswers(results);
    }
    throw lastRetryError || new Error('LightJev request failed');
  }
}

module.exports = {
  LightJevClient,
  LightJevError,
  questionsToRecords,
  resultsToAnswers,
};
