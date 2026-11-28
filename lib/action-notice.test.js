'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { GUIDE_UNAVAILABLE } = require('./review-prompt');
const { createStubJevlikeClient } = require('../stub-jevlike');
const {
  PHONE_UNRESOLVED,
  chatListName,
  buildActionNotice,
  composeActionNotice,
} = require('./action-notice');
const { applyReviewChoice } = require('./apply-review-choice');

describe('chat list name', () => {
  it('uses the address-book name for a saved contact', () => {
    assert.equal(
      chatListName(
        { isMyContact: true, name: '阿明', pushname: '推廣號' },
        { _data: { notifyName: '推廣號' } },
      ),
      '阿明',
    );
  });

  it('uses the push name before a block renames an unsaved contact', () => {
    assert.equal(
      chatListName(
        { isMyContact: false, name: '封鎖·惡意域名', pushname: '陌生推廣' },
        { _data: { notifyName: '陌生推廣' } },
      ),
      '陌生推廣',
    );
  });
});

describe('action notice', () => {
  it('states who was blocked, the phone, and the local reason', () => {
    const text = buildActionNotice({
      action: 'block',
      blocked: true,
      listName: '阿明',
      digits: '85290000000',
      heuristicId: 'malicious_host',
      archiveReason: 'jevlike_score',
      includeGuide: true,
      guide: '呢句催你交驗證碼。用你自己識嘅官方電話核實，唔好回覆個碼。',
    });
    assert.match(text, /^已封鎖並封存/);
    assert.match(text, /左邊：阿明/);
    assert.match(text, /電話：85290000000/);
    assert.doesNotMatch(text, /封鎖線/);
    assert.match(text, /句式：惡意域名/);
    assert.match(text, /評分達到封存線/);
    assert.match(text, /模型講解：/);
    assert.equal(text.includes('原本會'), false);
  });

  it('says the phone was not resolved and still names the chat', () => {
    const text = buildActionNotice({
      action: 'archive',
      listName: '左邊個',
      digits: null,
      archiveReason: 'obvious_scam',
      heuristicId: 'lookalike_domain',
    });
    assert.match(text, /^已封存，未封鎖/);
    assert.match(text, /左邊：左邊個/);
    assert.match(text, new RegExp(PHONE_UNRESOLVED));
    assert.equal(text.includes('模型講解'), false);
    assert.equal(text.includes('原本會'), false);
  });

  it('keeps a local receipt when the model explanation is missing', () => {
    const text = buildActionNotice({
      action: 'block',
      blocked: false,
      listName: '阿明',
      digits: '85290000000',
      includeGuide: true,
      guide: null,
    });
    assert.match(text, /^封鎖未完成，對話已嘗試封存/);
    assert.match(text, /左邊：阿明/);
    assert.match(text, new RegExp(GUIDE_UNAVAILABLE));
  });

  it('says the archive did not happen', () => {
    const archivedOnly = buildActionNotice({
      action: 'archive',
      archived: false,
      listName: '阿明',
      digits: '85290000000',
    });
    assert.match(archivedOnly, /^封存未完成/);
    const blocked = buildActionNotice({
      action: 'block',
      blocked: true,
      archived: false,
      listName: '阿明',
      digits: '85290000000',
    });
    assert.match(blocked, /^已封鎖，封存未完成/);
  });
});

describe('composeActionNotice', () => {
  it('sends only the desensitised transcript to the chat API', async () => {
    const raw = '我係陳大文 電話 91234567 驗證碼過期請發俾我';
    const listName = '左邊名阿明';
    const digits = '85290001122';
    let sent = null;
    const notice = await composeActionNotice({
      messages: [raw],
      listName,
      digits,
      action: 'block',
      blocked: true,
      score: 96,
      thresholds: { archive: 42, block: 80 },
      heuristicId: 'malicious_host',
      archiveReason: 'obvious_scam',
      maskClient: createStubJevlikeClient(),
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        apiKey: 'secret',
        fetchImpl: async (_url, opts) => {
          sent = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      guide: '呢句催你交驗證碼。用你自己識嘅官方電話核實，唔好回覆個碼。',
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    });
    const user = sent.messages[1].content;
    assert.equal(user.includes(listName), false);
    assert.equal(user.includes(digits), false);
    assert.equal(user.includes('91234567'), false);
    assert.equal(user.includes('陳大文'), false);
    assert.equal(sent.messages[0].content.includes(raw), false);
    assert.match(user, /XXX/);
    assert.equal(JSON.stringify(sent).includes('secret'), false);
    assert.match(notice.text, new RegExp(listName));
    assert.match(notice.text, new RegExp(digits));
    assert.match(notice.text, /驗證碼/);
    assert.equal(notice.text.includes('91234567'), false);
    assert.equal(notice.text.includes(raw), false);
  });

  it('still names the chat when masking fails', async () => {
    let called = false;
    const notice = await composeActionNotice({
      messages: ['驗證碼過期請發俾我'],
      listName: '左邊名阿明',
      digits: '85290001122',
      action: 'archive',
      maskClient: {
        async maskMessages() {
          throw new Error('mask down');
        },
      },
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async () => {
          called = true;
          throw new Error('should not call');
        },
      },
    });
    assert.equal(called, false);
    assert.equal(notice.guide, null);
    assert.match(notice.text, /已封存，未封鎖/);
    assert.match(notice.text, /左邊：左邊名阿明/);
    assert.match(notice.text, /電話：85290001122/);
    assert.match(notice.text, new RegExp(GUIDE_UNAVAILABLE));
  });

  it('reuses cached masks and still health-checks the worker with an empty batch', async () => {
    const raw = '我係陳大文 電話 91234567 驗證碼過期請發俾我';
    const masked = '我係XXX 電話 XXX 驗證碼過期請發俾我';
    const batches = [];
    let sent = null;
    await composeActionNotice({
      messages: [raw],
      action: 'archive',
      maskCache: new Map([[raw, masked]]),
      maskClient: {
        async maskMessages(messages) {
          batches.push([...messages]);
          return { messages: messages.map(() => ({ spans: [] })) };
        },
      },
      env: {},
      llmOptions: {
        apiUrl: 'http://llm.test/v1',
        fetchImpl: async (_url, opts) => {
          sent = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"guide":"用呢個官方渠道核實。"}' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    });
    assert.deepEqual(batches, [[]]);
    assert.equal(sent.messages[1].content, `[1] ${masked}`);
    assert.equal(sent.messages[1].content.includes('91234567'), false);
    assert.equal(sent.messages[1].content.includes('陳大文'), false);
  });
});

describe('guided confirmation', () => {
  it('adds the local identity after archive or block and does not add a model section', async () => {
    const record = {
      chatId: '85290000000@c.us',
      digits: '85290000000',
      listName: '阿明',
      savedContact: false,
      score: 86,
      archiveReason: 'jevlike_score',
      heuristicId: 'lookalike_domain',
      thresholds: { archive: 42, block: 80 },
    };
    const archived = await applyReviewChoice(record, 'archive', {
      getChat: async (id) => ({ id }),
      archiveChat: async () => {},
    });
    assert.match(archived.text, /^已封存，未封鎖/);
    assert.match(archived.text, /左邊：阿明/);
    assert.match(archived.text, /電話：85290000000/);
    assert.doesNotMatch(archived.text, /分數|封存線 \d/);
    assert.match(archived.text, /假域名/);
    assert.equal(archived.text.includes('模型講解'), false);

    const left = await applyReviewChoice(
      { ...record, chatId: '1@c.us' },
      'leave',
      {},
    );
    assert.equal(left.text, '已留低，冇封存亦冇封鎖。');
    assert.equal(left.text.includes('阿明'), false);
  });
});
