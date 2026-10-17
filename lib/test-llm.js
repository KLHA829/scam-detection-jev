'use strict';

const { createStubJevlikeClient } = require('../stub-jevlike');
const { loadRubric } = require('./score-message');

const rubric = loadRubric();

function llmChatResponse(obj, status = 200) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(obj) } }],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
}

function scamLlmFetch(extra = {}) {
  return llmChatResponse({
    label: 'scam',
    confidence: 0.9,
    signals: [],
    should_archive: true,
    reason: 'test',
    ...extra,
  });
}

function notScamLlmFetch(extra = {}) {
  return llmChatResponse({
    label: 'not_scam',
    confidence: 0.8,
    signals: [],
    should_archive: false,
    reason: 'test',
    ...extra,
  });
}

/** Primary-path deps: stub mask client + OpenAI-compatible LLM mock. */
function primaryPathDeps({ fetchImpl, env, maskClient, ...rest } = {}) {
  return {
    env,
    maskClient: maskClient || createStubJevlikeClient(),
    rubric,
    llmReview: {
      enabled: true,
      apiUrl: 'http://llm.test/v1',
      fetchImpl: fetchImpl || scamLlmFetch(),
    },
    resolveNumber: async () => ({
      digits: '85261234567',
      unresolvedLid: false,
    }),
    archiveChat: async () => {},
    ...rest,
  };
}

function llmOffDeps(extra = {}) {
  return {
    maskClient: createStubJevlikeClient(),
    rubric,
    llmReview: { enabled: false },
    resolveNumber: async () => ({ digits: '85261234567', unresolvedLid: false }),
    archiveChat: async () => {},
    ...extra,
  };
}

module.exports = {
  rubric,
  llmChatResponse,
  scamLlmFetch,
  notScamLlmFetch,
  primaryPathDeps,
  llmOffDeps,
};
