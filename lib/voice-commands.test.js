'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  VoiceCommandClient,
  convertSpokenDigits,
  normalizeVoiceTranscript,
  requireLoopbackBaseURL,
  resolveTranscribeUrl,
  voiceCommandsEnabled,
} = require('./voice-commands');

describe('voice command helpers', () => {
  it('normalizes Cantonese ASR output for existing commands', () => {
    assert.equal(convertSpokenDigits('九一二三四五六七'), '91234567');
    assert.equal(convertSpokenDigits('零兩三四'), '0234');
    assert.equal(normalizeVoiceTranscript('解封九一二三四五六七。'), '解封91234567');
    assert.equal(normalizeVoiceTranscript('保持封锁'), '保持封鎖');
    assert.equal(normalizeVoiceTranscript('帮助'), '幫助');
    assert.equal(normalizeVoiceTranscript('唔該解封啦。'), '解封');
    assert.equal(normalizeVoiceTranscript('唔该，解封啦。'), '解封');
    assert.equal(normalizeVoiceTranscript('解封😡'), '解封');
    assert.equal(normalizeVoiceTranscript('唔好封🎼'), '唔好封');
  });

  it('is opt-in and resolves worker URLs', () => {
    assert.equal(voiceCommandsEnabled({}), false);
    assert.equal(voiceCommandsEnabled({ VOICE_COMMANDS_ENABLED: 'true' }), true);
    assert.equal(voiceCommandsEnabled({ VOICE_COMMANDS_ENABLED: '0' }), false);
    assert.equal(resolveTranscribeUrl('http://127.0.0.1:8768/'), 'http://127.0.0.1:8768/v1/transcribe');
    assert.equal(resolveTranscribeUrl('http://localhost:8768/v1/transcribe'), 'http://localhost:8768/v1/transcribe');
    assert.equal(requireLoopbackBaseURL('http://[::1]:8768'), 'http://[::1]:8768');
    assert.throws(() => requireLoopbackBaseURL('http://asr.example'), /loopback/);
  });

  it('posts local audio as base64 and returns transcript text', async () => {
    const calls = [];
    const client = new VoiceCommandClient({
      baseURL: 'http://127.0.0.1:8768',
      env: { VOICE_ASR_LANGUAGE: 'yue' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ text: '解除' });
          },
        };
      },
    });
    const text = await client.transcribeMedia({ dataBase64: 'b2dn', mimetype: 'audio/ogg' });
    assert.equal(text, '解除');
    assert.equal(calls[0].url, 'http://127.0.0.1:8768/v1/transcribe');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      audioBase64: 'b2dn',
      mimetype: 'audio/ogg',
      language: 'yue',
    });
  });

  it('sends a scoped command context when one is provided', async () => {
    const bodies = [];
    const client = new VoiceCommandClient({
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ text: '唔好封' });
          },
        };
      },
    });
    await client.transcribeMedia({ dataBase64: 'b2dn' }, { context: '封佢, 唔好封' });
    assert.equal(bodies[0].context, '封佢, 唔好封');
  });

  it('rejects invalid media and invalid worker responses', async () => {
    const client = new VoiceCommandClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return '{}';
        },
      }),
    });
    await assert.rejects(() => client.transcribeMedia(null), /voice media unavailable/);
    await assert.rejects(() => client.transcribeMedia({ dataBase64: 'b2dn' }), /invalid voice ASR response/);
  });
});
