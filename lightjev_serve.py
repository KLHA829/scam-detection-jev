#!/usr/bin/env python3
"""Persistent LightJev scoring worker.

Loads the checkpoint once (unlike lightjev.inference.predict, which reloads
on every call) and scores boolean/choice/score records in one backbone batch.

POST /predict  {"records": [LightJev record, ...]}
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

DEVICE = os.environ.get("LIGHTJEV_DEVICE", "cpu")
CHECKPOINT = os.environ.get("LIGHTJEV_CHECKPOINT", "rongxinzy/LightJev-0.6B-v0.1")
HOST = os.environ.get("LIGHTJEV_HOST", "127.0.0.1")
PORT = int(os.environ.get("LIGHTJEV_PORT", os.environ.get("STUB_LIGHTJEV_PORT", "8765")))
API_KEY = os.environ.get("LIGHTJEV_API_KEY", os.environ.get("OPENJEV_API_KEY", ""))
TEMPERATURE = float(os.environ.get("LIGHTJEV_TEMPERATURE", "1"))

_MODEL = None
_TOKENIZER = None
_CONFIG = None
_CHECKPOINT_PATH = None
_SCORE_LOCK = threading.Lock()


def resolve_checkpoint(spec: str) -> str:
    path = Path(spec)
    if (path / "manifest.json").is_file():
        return str(path)
    from huggingface_hub import snapshot_download

    return snapshot_download(spec)


def load_runtime():
    global _MODEL, _TOKENIZER, _CONFIG, _CHECKPOINT_PATH
    import torch
    from lightjev.inference import load_checkpoint

    _CHECKPOINT_PATH = resolve_checkpoint(CHECKPOINT)
    device = DEVICE
    if device == "cuda":
        if not torch.cuda.is_available():
            print("[WARN] CUDA requested but unavailable; using cpu", file=sys.stderr)
            device = "cpu"
    _MODEL, _TOKENIZER, _CONFIG = load_checkpoint(_CHECKPOINT_PATH, device)
    print(
        f"[OK] LightJev loaded checkpoint={_CHECKPOINT_PATH} device={device} "
        f"max_length={_CONFIG.get('max_length')}",
        flush=True,
    )


def score_records(records: list[dict]) -> list[dict]:
    import torch
    from lightjev.model import encode_records
    from lightjev.schema import validate_record

    if _MODEL is None:
        raise RuntimeError("checkpoint not loaded")
    validated = [validate_record(row) for row in records]
    if not validated:
        raise ValueError("records must not be empty")
    max_length = int(_CONFIG.get("max_length") or 256)
    encoded = encode_records(validated, _TOKENIZER, max_length)
    device = next(_MODEL.parameters()).device
    batch = {
        key: value.to(device) if torch.is_tensor(value) else value
        for key, value in encoded.items()
    }
    temperature = TEMPERATURE
    if not temperature or temperature <= 0:
        raise ValueError("temperature must be positive")
    with _SCORE_LOCK:
        with torch.no_grad():
            logits_list = _MODEL(**batch)
        results = []
        for record, logits in zip(validated, logits_list):
            probabilities = (logits.float() / temperature).softmax(-1)
            if not torch.isfinite(probabilities).all():
                raise ValueError("nonfinite probabilities")
            probs = probabilities.detach().cpu().tolist()
            index = int(probabilities.argmax().item())
            row = {
                "id": record["id"],
                "kind": record["kind"],
                "candidates": record["candidates"],
                "probabilities": probs,
                "temperature": temperature,
                "selected": record["candidates"][index],
                "selected_index": index,
            }
            if record["kind"] == "score":
                row["expectation"] = sum(i * p for i, p in enumerate(probs))
            results.append(row)
        return results


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
        if self.path.split("?", 1)[0] != "/health":
            self._send(404, {"error": "not found"})
            return
        self._send(
            200,
            {
                "ok": _MODEL is not None,
                "checkpoint": _CHECKPOINT_PATH,
                "device": str(next(_MODEL.parameters()).device) if _MODEL is not None else None,
                "max_length": None if _CONFIG is None else _CONFIG.get("max_length"),
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if not authorized(self):
            self._send(401, {"error": "unauthorized"})
            return
        path = self.path.split("?", 1)[0]
        if path != "/predict":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(422, {"error": "invalid json"})
            return
        records = payload.get("records") if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            self._send(422, {"error": "records must be a list"})
            return
        try:
            results = score_records(records)
        except ValueError as exc:
            self._send(422, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"error": str(exc)})
            return
        self._send(200, {"model": "lightjev", "results": results})


def main() -> None:
    load_runtime()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[INFO] LightJev worker listening on http://{HOST}:{PORT}/predict", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
