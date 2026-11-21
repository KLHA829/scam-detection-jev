'use strict';

const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { processIncomingMessage } = require(path.join(root, 'lib/handle-incoming'));
const { createThreadContext } = require(path.join(root, 'lib/thread-context'));
const { explainSuspicion } = require(path.join(root, 'lib/review-guide'));
const { composeActionNotice } = require(path.join(root, 'lib/action-notice'));
const { llmOffDeps } = require(path.join(root, 'lib/test-llm'));

async function main() {
  for (const operatorMode of ['auto', 'guided']) {
    const threadContext = createThreadContext({ turns: 4 });
    const deps = llmOffDeps({ operatorMode, threadContext });
    const send = (body, editedFrom) => processIncomingMessage(
      { type: 'chat', chatId: 'demo@c.us', body, messageId: 'demo-message' },
      { ...deps, editedFrom },
    );
    await send('earlier one');
    await send('earlier two');
    const original = 'ORIGINAL https://whatsapp-secure.com';
    await send(original);
    const result = await send('EDITED https://whatsapp-secure.com', original);
    const options = {
      messages: result.reviewMessages,
      maskClient: deps.maskClient,
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (_url, init) => new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            guide: JSON.parse(init.body).messages[1].content,
          }) } }],
        }), { status: 200 }),
      },
    };
    console.log(`\n${operatorMode}: original -> edit (stub model echoes masked transcript)`);
    if (operatorMode === 'auto') {
      const notice = await composeActionNotice({
        ...options, action: 'archive', archived: result.archived, listName: 'Demo',
      });
      console.log(notice.text);
    } else {
      console.log((await explainSuspicion(options)).guide);
    }
    console.log('retained context:', JSON.stringify(threadContext.prior('demo@c.us')));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
