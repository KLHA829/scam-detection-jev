# Voice operator commands

Self-chat push-to-talk voice notes (not audio file attachments) can be transcribed locally into Cantonese operator commands when `VOICE_COMMANDS_ENABLED=true`. The path is WhatsApp media download → local `voice_asr_serve.py` transcript → existing quoted review/unblock or direct operator command parser. The audio never goes to the scam-review LLM.

## Sub-features

- `whatsmeow` caches only self-chat push-to-talk voice-message metadata in memory and serves bytes through authenticated `GET /v1/message/media?id=...`; other chats are not cached.
- Legacy `wwebjs` uses `message.downloadMedia()`.
- `lib/voice-commands.js` posts base64 audio to a loopback-only local ASR worker with language `yue`.
- `lib/wa-handlers.test.js` proves a transcribed `唔好封` resolves a quoted review as leave, `解封` resolves an unblock prompt, and ASR failure sends a failure notice without acting.
- `voice_asr_serve.py` uses ffmpeg + the WSYue Cantonese-fine-tuned SenseVoice model by default; an optional Qwen backend can be selected with `VOICE_ASR_BACKEND=qwen`. Qwen command context is scoped by the quoted poll and cross-checked against a no-context transcript so silence/noise cannot hallucinate a bare command. Offline Python tests avoid model downloads.

## How to get to it (user POV)

Install `requirements-voice.txt` (or `requirements-voice-qwen.txt` for the optional Qwen backend), start `python voice_asr_serve.py`, set `VOICE_COMMANDS_ENABLED=true`, then send a Cantonese voice note in your own WhatsApp self-chat. Quote a review/unblock poll when answering it.

## Driving it with verify-scam-bot

No live WhatsApp QR or FunASR download is needed for offline proof:

```bash
.cursor/skills/verify-scam-bot/bin/drive-voice-operator-commands
node --test lib/wa-transport/contract.test.js lib/wa-transport/whatsmeow.test.js
(cd wa-bridge && go test ./...)
python3 -m unittest test_voice_asr_serve.py
```

## Gotchas

- Voice commands are opt-in. `VOICE_COMMANDS_ENABLED` is false by default.
- Transcription or media-download failure must not block, archive, unblock, or resolve a poll.
- `voice_asr_serve.py` does not read `.env`; export worker settings in its shell.
- ffmpeg is required to decode WhatsApp Ogg/Opus audio.
- The Qwen backend is command-accuracy-oriented but heavier; keep FunASR/WSYue as the default unless the operator explicitly chooses Qwen. Do not bypass the no-context cross-check: without it, Qwen context biasing can hallucinate `封佢`/`解封` on silence, noise, or tones.
