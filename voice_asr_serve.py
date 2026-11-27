#!/usr/bin/env python3
"""Local Cantonese voice-command transcription worker.

POST /v1/transcribe {"audioBase64":"...","mimetype":"audio/ogg","language":"yue"}
GET  /health

The worker is intentionally loopback-only by default. Audio stays on this machine;
install the optional FunASR dependencies from requirements-voice.txt before running.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import subprocess
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8768
DEFAULT_MODEL = "ASLP-lab/WSYue-ASR/sensevoice_small_yue"
DEFAULT_LANGUAGE = "yue"
MAX_JSON_BODY = 24 * 1024 * 1024
MAX_AUDIO_BYTES = 12 * 1024 * 1024
FFMPEG_TIMEOUT_SECONDS = 15

HOST = os.environ.get("VOICE_ASR_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
try:
    PORT = int(os.environ.get("VOICE_ASR_PORT", str(DEFAULT_PORT)) or DEFAULT_PORT)
except ValueError:
    PORT = DEFAULT_PORT
MODEL_ID = os.environ.get("VOICE_ASR_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
DEVICE = os.environ.get("VOICE_ASR_DEVICE", "cpu").strip() or "cpu"
LANGUAGE = os.environ.get("VOICE_ASR_LANGUAGE", DEFAULT_LANGUAGE).strip() or DEFAULT_LANGUAGE
API_KEY = os.environ.get("VOICE_ASR_API_KEY", "")
FFMPEG = os.environ.get("VOICE_ASR_FFMPEG", "ffmpeg").strip() or "ffmpeg"

_MODEL = None
_MODEL_ERROR = None
_MODEL_LOCK = threading.Lock()
_ALLOWED_LANGUAGES = {"auto", "zh", "en", "yue", "ja", "ko", "nospeech"}


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def write_json(handler: BaseHTTPRequestHandler, status: int, value: object) -> None:
    body = json_bytes(value)
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not API_KEY:
        return True
    return handler.headers.get("Authorization", "") == f"Bearer {API_KEY}"


def decode_audio(payload: object) -> tuple[bytes, str]:
    if not isinstance(payload, dict):
        raise ValueError("json object required")
    encoded = payload.get("audioBase64")
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("audioBase64 is required")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("audioBase64 is invalid") from exc
    if not audio:
        raise ValueError("audioBase64 is empty")
    if len(audio) > MAX_AUDIO_BYTES:
        raise ValueError(f"audio exceeds {MAX_AUDIO_BYTES} bytes")
    language = str(payload.get("language") or LANGUAGE).strip() or LANGUAGE
    if language not in _ALLOWED_LANGUAGES:
        raise ValueError("unsupported language")
    return audio, language


def convert_to_wav(audio: bytes) -> bytes:
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd,
            input=audio,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"ffmpeg failed: {exc}") from exc
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace").strip()[:200]
        raise RuntimeError(f"ffmpeg could not decode audio{': ' + detail if detail else ''}")
    return proc.stdout

COMMAND_TRANSCRIPT_CORRECTIONS = (
    ("唔好風", "唔好封"),
    ("唔好风", "唔好封"),
    ("唔想風", "唔想封"),
    ("唔想风", "唔想封"),
    ("風佢", "封佢"),
    ("风佢", "封佢"),
    ("解風", "解封"),
    ("解风", "解封"),
    ("風存", "封存"),
    ("风存", "封存"),
    ("風鎖", "封鎖"),
    ("风鎖", "封鎖"),
    ("風锁", "封鎖"),
    ("风锁", "封鎖"),
)


def correct_command_transcript(text: str) -> str:
    for wrong, right in COMMAND_TRANSCRIPT_CORRECTIONS:
        text = text.replace(wrong, right)
    return text


def resolve_model_path(model_id: str, snapshot_download=None) -> str:
    if model_id not in {"ASLP-lab/WSYue-ASR", "ASLP-lab/WSYue-ASR/sensevoice_small_yue"}:
        return model_id
    if snapshot_download is None:
        from huggingface_hub import snapshot_download as download
    else:
        download = snapshot_download
    root = download("ASLP-lab/WSYue-ASR", allow_patterns=["sensevoice_small_yue/*"])
    return os.path.join(root, "sensevoice_small_yue")


def load_model():
    global _MODEL, _MODEL_ERROR
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        if _MODEL_ERROR is not None:
            raise RuntimeError(_MODEL_ERROR)
        try:
            from funasr import AutoModel

            _MODEL = AutoModel(
                model=resolve_model_path(MODEL_ID),
                vad_model="fsmn-vad",
                vad_kwargs={"max_single_segment_time": 30000},
                device=DEVICE,
                hub="hf",
                disable_update=True,
            )
        except Exception as exc:  # pragma: no cover - exact import/model errors are environment-specific
            _MODEL_ERROR = str(exc)
            raise RuntimeError(_MODEL_ERROR) from exc
        return _MODEL


def transcribe_audio(audio: bytes, language: str) -> str:
    wav = convert_to_wav(audio)
    model = load_model()
    from funasr.utils.postprocess_utils import rich_transcription_postprocess

    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    try:
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(wav)
        with _MODEL_LOCK:
            result = model.generate(
                input=tmp_path,
                cache={},
                language=language,
                use_itn=True,
                batch_size_s=60,
                merge_vad=True,
                merge_length_s=15,
                output_dir=None,
            )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    if not result or not isinstance(result[0], dict):
        return ""
    text = str(rich_transcription_postprocess(str(result[0].get("text") or ""))).strip()
    return correct_command_transcript(text)


class VoiceAsrHandler(BaseHTTPRequestHandler):
    server_version = "voice-asr/1"

    def log_message(self, fmt: str, *args: object) -> None:
        print(fmt % args, file=sys.stderr, flush=True)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/health":
            write_json(self, 404, {"error": "not found"})
            return
        write_json(self, 200, {"ok": True, "model": MODEL_ID, "language": LANGUAGE})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/v1/transcribe":
            write_json(self, 404, {"error": "not found"})
            return
        if not authorized(self):
            write_json(self, 401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_JSON_BODY:
            write_json(self, 413, {"error": "invalid request size"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            audio, language = decode_audio(payload)
            text = transcribe_audio(audio, language)
        except ValueError as exc:
            write_json(self, 400, {"error": str(exc)})
            return
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            write_json(self, 503, {"error": str(exc)[:300]})
            return
        write_json(self, 200, {"text": text})


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), VoiceAsrHandler)
    print(f"voice ASR worker listening on http://{HOST}:{PORT} model={MODEL_ID} device={DEVICE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
