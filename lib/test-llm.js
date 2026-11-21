'use strict';

const { createStubJevlikeClient } = require('../stub-jevlike');

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
    env: { CONTEXT_LLM_ENABLED: '0', ...env },
    maskClient: maskClient || createStubJevlikeClient(),
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

function llmOffDeps({ env, ...rest } = {}) {
  return {
    env: { CONTEXT_LLM_ENABLED: '0', ...env },
    maskClient: createStubJevlikeClient(),
    llmReview: { enabled: false },
    resolveNumber: async () => ({ digits: '85261234567', unresolvedLid: false }),
    archiveChat: async () => {},
    ...rest,
  };
}

module.exports = {
  llmChatResponse,
  scamLlmFetch,
  notScamLlmFetch,
  primaryPathDeps,
  llmOffDeps,
};
