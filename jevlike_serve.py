#!/usr/bin/env python3
"""Persistent HF-encoder jevlike scoring worker (Pi / CPU friendly).

Loads a small jevlike head checkpoint (~2 MB) once and the frozen Hugging Face
encoder (`hfl/chinese-roberta-wwm-ext` by default) from the Hub on first run.
The encoder is NOT shipped in git.

POST /v1/score  {"text":"..."} -> {prob_scam, prob_not_scam, label, score}
POST /predict   same body (or {"context","options"})
GET  /health
"""
from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_ENCODER = "hfl/chinese-roberta-wwm-ext"
DEFAULT_OPTIONS = ("not_scam", "scam")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
RELEASE_TAG = "jevlike-hf-hn800"
RELEASE_ASSET = "jevlike_hf_chinese_roberta_hn800.pt"
RELEASE_DOWNLOAD_URL = (
    "https://github.com/KLHA829/scam-detection-jev/releases/download/"
    f"{RELEASE_TAG}/{RELEASE_ASSET}"
)
ENCODER_DOWNLOAD_NOTE = (
    "[WARN] First run downloads the frozen HF encoder "
    f"{DEFAULT_ENCODER} (~400 MB) into the Hugging Face cache. "
    "On a Raspberry Pi this can take several minutes and needs disk + RAM."
)

CKPT_CANDIDATES = (
    ROOT / "models" / "jevlike_hf_chinese_roberta.pt",
    ROOT / "models" / "jevlike_hf_chinese_roberta_hn800.pt",
    ROOT / "models" / "hf_chinese_roberta_hn800.pt",
)

DEVICE = os.environ.get("JEVLIKE_DEVICE", "cpu")
HOST = os.environ.get("JEVLIKE_HOST", DEFAULT_HOST)
PORT = int(os.environ.get("JEVLIKE_PORT", str(DEFAULT_PORT)))
API_KEY = os.environ.get("JEVLIKE_API_KEY", "")
MAX_BODY = int(os.environ.get("JEVLIKE_MAX_BODY", "65536"))

_MODEL = None
_COLLATOR = None
_CONFIG: dict | None = None
_CHECKPOINT_PATH = None
_ENCODER_ID = None
_OPTIONS: tuple[str, ...] = DEFAULT_OPTIONS
_DEVICE = None
_SCORE_LOCK = threading.Lock()


def parse_options(raw: str | None) -> tuple[str, ...]:
    if raw is None or str(raw).strip() == "":
        return DEFAULT_OPTIONS
    parts = tuple(p.strip() for p in str(raw).split(",") if p.strip())
    if len(parts) < 2:
        raise ValueError("JEVLIKE_OPTIONS needs at least two labels")
    return parts


def option_index(options: list[str] | tuple[str, ...], name: str) -> int | None:
    want = name.strip().lower()
    for i, option in enumerate(options):
        if str(option).strip().lower() == want:
            return i
    return None


def scam_probability(options: list[str] | tuple[str, ...], probabilities: list[float]) -> float:
    """P(scam) from a jevlike softmax over choice labels."""
    if not probabilities:
        raise ValueError("probabilities must not be empty")
    idx = option_index(options, "scam")
    if idx is None:
        idx = len(probabilities) - 1
    if idx >= len(probabilities):
        raise ValueError("scam option index out of range")
    return float(probabilities[idx])


def resolve_checkpoint() -> Path:
    spec = os.environ.get("JEVLIKE_CKPT") or os.environ.get("JEVLIKE_CHECKPOINT") or ""
    if spec.strip():
        path = Path(spec).expanduser()
        if not path.is_file():
            raise FileNotFoundError(
                f"JEVLIKE_CKPT not found: {path}. "
                f"Download {RELEASE_DOWNLOAD_URL} (see models/README.md)."
            )
        return path
    for candidate in CKPT_CANDIDATES:
        if candidate.is_file():
            return candidate
    tried = ", ".join(str(p) for p in CKPT_CANDIDATES)
    raise FileNotFoundError(
        "jevlike checkpoint not found. Download "
        f"{RELEASE_DOWNLOAD_URL} into models/ "
        f"(looked at: {tried}) or set JEVLIKE_CKPT. See models/README.md "
        "and scripts/download_jevlike_ckpt.sh."
    )


def load_runtime() -> None:
    global _MODEL, _COLLATOR, _CONFIG, _CHECKPOINT_PATH, _ENCODER_ID, _OPTIONS, _DEVICE
    import torch
    from jevlike.model import make_system

    _OPTIONS = parse_options(os.environ.get("JEVLIKE_OPTIONS"))
    _CHECKPOINT_PATH = resolve_checkpoint()
    print(ENCODER_DOWNLOAD_NOTE, file=sys.stderr, flush=True)

    payload = torch.load(_CHECKPOINT_PATH, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict) or "config" not in payload or "state_dict" not in payload:
        raise ValueError("checkpoint is not a jevlike {'config','state_dict'} payload")
    config = dict(payload["config"])
    encoder = (
        os.environ.get("JEVLIKE_ENCODER")
        or os.environ.get("JEVLIKE_HF_MODEL")
        or config.get("hf_model")
        or DEFAULT_ENCODER
    )
    if config.get("hf_model") and config["hf_model"] != encoder:
        print(
            f"[WARN] overriding checkpoint encoder {config['hf_model']} -> {encoder}",
            file=sys.stderr,
            flush=True,
        )
    config["hf_model"] = encoder
    config["encoder"] = "hf"
    _CONFIG = config
    _ENCODER_ID = encoder

    device_name = DEVICE or "cpu"
    if device_name == "cuda":
        if not torch.cuda.is_available():
            print("[WARN] CUDA requested but unavailable; using cpu", file=sys.stderr)
            device_name = "cpu"
    _DEVICE = torch.device(device_name)
    _MODEL, _COLLATOR = make_system(config, _DEVICE)
    missing, unexpected = _MODEL.load_state_dict(payload["state_dict"], strict=False)
    if unexpected or any(not name.startswith("encoder.") for name in missing):
        raise ValueError(
            f"checkpoint mismatch: missing={missing}, unexpected={unexpected}"
        )
    _MODEL.eval()
    print(
        f"[OK] jevlike loaded checkpoint={_CHECKPOINT_PATH} encoder={encoder} "
        f"device={_DEVICE} options={list(_OPTIONS)} "
        f"context_tokens={config.get('context_tokens')} "
        f"rank={config.get('rank')}",
        flush=True,
    )


def score_text(text: str, options: tuple[str, ...] | None = None) -> dict:
    import torch
    from jevlike.data import ChoiceExample
    from jevlike.train import move

    if _MODEL is None or _COLLATOR is None:
        raise RuntimeError("checkpoint not loaded")
    body = (text or "").strip()
    if not body:
        raise ValueError("text is required")
    labels = options or _OPTIONS
    if len(labels) < 2:
        raise ValueError("need at least two options")

    batch = move(_COLLATOR([ChoiceExample(body, tuple(labels), 0)]), _DEVICE)
    with _SCORE_LOCK:
        with torch.no_grad():
            logits = _MODEL(batch)
            probabilities = logits.softmax(-1)[0, : len(labels)].float().cpu().tolist()
    p_scam = scam_probability(labels, probabilities)
    p_not = max(0.0, min(1.0, 1.0 - p_scam))
    idx_not = option_index(labels, "not_scam")
    if idx_not is not None and idx_not < len(probabilities):
        p_not = float(probabilities[idx_not])
    pred = "scam" if p_scam >= p_not else "not_scam"
    score = round(p_scam * 100.0, 4)
    return {
        "ok": True,
        "model": "jevlike",
        "encoder": _ENCODER_ID,
        "checkpoint": None if _CHECKPOINT_PATH is None else str(_CHECKPOINT_PATH),
        "label": pred,
        "prob_scam": round(p_scam, 6),
        "prob_not_scam": round(p_not, 6),
        "score": score,
        "options": list(labels),
        "probabilities": [round(float(p), 6) for p in probabilities],
        "device": None if _DEVICE is None else str(_DEVICE),
    }


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not API_KEY:
        return True
    header = handler.headers.get("Authorization", "")
    return header == f"Bearer {API_KEY}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[INFO] " + (fmt % args) + "\n")

    def _send(self, status: int, payload: dict | list) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ("/health", "/healthz"):
            self._send(404, {"error": "not found"})
            return
        self._send(
            200,
            {
                "ok": _MODEL is not None,
                "model": "jevlike",
                "checkpoint": None if _CHECKPOINT_PATH is None else str(_CHECKPOINT_PATH),
                "encoder": _ENCODER_ID,
                "device": None if _DEVICE is None else str(_DEVICE),
                "options": list(_OPTIONS),
                "context_tokens": None if _CONFIG is None else _CONFIG.get("context_tokens"),
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if not authorized(self):
            self._send(401, {"error": "unauthorized"})
            return
        path = self.path.split("?", 1)[0]
        if path not in ("/predict", "/v1/score", "/score"):
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            self._send(413, {"error": "payload_too_large"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(422, {"error": "invalid json"})
            return
        if not isinstance(payload, dict):
            self._send(422, {"error": "body must be an object"})
            return
        text = payload.get("text") or payload.get("message") or payload.get("context") or ""
        options = payload.get("options")
        labels = None
        if isinstance(options, list) and len(options) >= 2:
            labels = tuple(str(x) for x in options)
        try:
            result = score_text(str(text), labels)
        except ValueError as exc:
            self._send(422, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"error": str(exc)})
            return
        self._send(200, result)


def main() -> None:
    load_runtime()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"[INFO] jevlike worker listening on http://{HOST}:{PORT}/v1/score",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
