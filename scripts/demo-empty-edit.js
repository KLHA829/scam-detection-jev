'use strict';

const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { processIncomingMessage } = require(path.join(root, 'lib/handle-incoming'));
const { createRecentContext } = require(path.join(root, 'lib/context-llm'));

async function main() {
  for (const earlier of [[], ['a']]) {
    const transcripts = [];
    const recentContext = createRecentContext();
    const deps = {
      env: { CONTEXT_LLM_ENABLED: 'true', HEURISTIC_ENABLED: 'false', LLM_REVIEW_COOLDOWN_MS: '0' },
      recentContext,
      maskClient: {
        async maskMessages(messages) {
          return { messages: messages.map(() => ({ spans: [] })) };
        },
      },
      contextLlm: {
        enabled: true,
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (_url, opts) => {
          transcripts.push(JSON.parse(opts.body).messages[1].content);
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            action: 'no_action', confidence: 0.9,
          }) } }] }));
        },
      },
    };
    const send = (body, editedFrom) => processIncomingMessage(
      { type: 'chat', chatId: 'demo-empty@c.us', body }, { ...deps, editedFrom },
    );
    for (const body of earlier) await send(body);
    await send('scam text');
    transcripts.length = 0;
    const out = await send('', 'scam text');
    console.log(JSON.stringify({ earlier, transcripts, retained: recentContext.recent('demo-empty@c.us'),
      action: out.decision.action, skipped: out.llmTrigger.skipped || null }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
