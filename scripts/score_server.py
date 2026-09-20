#!/usr/bin/env python3
"""Minimal HTTP scorer for the fine-tuned zh/yue scam classifier.

Weights are NOT in this repo. Point SCAM_CLASSIFIER_MODEL at the folder that
contains the fine-tuned `hfl/chinese-roberta-wwm-ext` checkpoint
(e.g. C:\\Users\\Aidan\\scam-finetune\\model\\).

POST /v1/score  {"text":"..."} -> {"label","prob_scam","prob_not_scam"}
GET  /healthz  (also /health)
"""
from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_DIR = Path(os.environ.get("SCAM_CLASSIFIER_MODEL", Path(__file__).resolve().parent / "model"))
HOST = os.environ.get("SCAM_CLASSIFIER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCAM_CLASSIFIER_PORT", "8099"))
THRESH = float(os.environ.get("SCAM_CLASSIFIER_THRESH", "0.85"))
MAX_LENGTH = int(os.environ.get("SCAM_CLASSIFIER_MAX_LENGTH", "256"))
MAX_BODY = int(os.environ.get("SCAM_CLASSIFIER_MAX_BODY", "65536"))

_DEVICE = None
_TOKENIZER = None
_MODEL = None
_ID2LABEL: dict[int, str] = {}
_SCAM_INDEX = 1
_NOT_SCAM_INDEX = 0
_SCORE_LOCK = threading.Lock()


def _is_scam_name(name: str) -> bool:
    n = str(name).strip().lower()
    return n in {"scam", "label_1", "1"}


def load_runtime() -> None:
    global _DEVICE, _TOKENIZER, _MODEL, _ID2LABEL, _SCAM_INDEX, _NOT_SCAM_INDEX
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    if not MODEL_DIR.exists():
        raise FileNotFoundError(
            f"classifier model folder not found: {MODEL_DIR}. "
            "Set SCAM_CLASSIFIER_MODEL to the fine-tuned checkpoint directory."
        )

    device_name = "cuda" if torch.cuda.is_available() else "cpu"
    _DEVICE = torch.device(device_name)
    _TOKENIZER = AutoTokenizer.from_pretrained(MODEL_DIR)
    _MODEL = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR).to(_DEVICE).eval()

    label_map_path = MODEL_DIR / "label_map.json"
    if label_map_path.is_file():
        label_map = json.loads(label_map_path.read_text(encoding="utf-8"))
        raw = label_map.get("id2label") or {}
        _ID2LABEL = {int(k): str(v) for k, v in raw.items()}
    else:
        cfg = getattr(_MODEL.config, "id2label", None) or {}
        _ID2LABEL = {int(k): str(v) for k, v in cfg.items()}

    scam_hits = [i for i, name in _ID2LABEL.items() if _is_scam_name(name)]
    _SCAM_INDEX = scam_hits[0] if scam_hits else 1
    other = [i for i in _ID2LABEL if i != _SCAM_INDEX]
    _NOT_SCAM_INDEX = other[0] if other else (0 if _SCAM_INDEX != 0 else 1)
    print(
        f"[OK] classifier loaded model={MODEL_DIR} device={_DEVICE} "
        f"thresh={THRESH} scam_index={_SCAM_INDEX}",
        flush=True,
    )


def score(text: str) -> dict:
    import torch

    if _MODEL is None or _TOKENIZER is None or _DEVICE is None:
        raise RuntimeError("classifier not loaded")
    inputs = _TOKENIZER(text, return_tensors="pt", truncation=True, max_length=MAX_LENGTH)
    inputs = {k: v.to(_DEVICE) for k, v in inputs.items()}
    with _SCORE_LOCK:
        with torch.no_grad():
            probs = torch.softmax(_MODEL(**inputs).logits, dim=-1)[0].cpu().tolist()
    prob_scam = float(probs[_SCAM_INDEX]) if _SCAM_INDEX < len(probs) else float(probs[-1])
    prob_not = float(probs[_NOT_SCAM_INDEX]) if _NOT_SCAM_INDEX < len(probs) else 1.0 - prob_scam
    pred = "scam" if prob_scam >= THRESH else "not_scam"
    return {
        "label": pred,
        "prob_scam": round(prob_scam, 6),
        "prob_not_scam": round(prob_not, 6),
        "threshold": THRESH,
        "model": str(MODEL_DIR),
        "device": str(_DEVICE),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[INFO] " + (fmt % args) + "\n")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/healthz", "/health"):
            return self._json(
                200,
                {
                    "ok": _MODEL is not None,
                    "device": None if _DEVICE is None else str(_DEVICE),
                    "threshold": THRESH,
                },
            )
        return self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ("/v1/score", "/score"):
            return self._json(404, {"error": "not_found"})
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "payload_too_large"})
        raw = self.rfile.read(n) if n else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._json(400, {"error": "invalid_json"})
        if not isinstance(payload, dict):
            return self._json(400, {"error": "invalid_json"})
        text = (payload.get("text") or payload.get("message") or "").strip()
        if not text:
            return self._json(400, {"error": "text_required"})
        try:
            return self._json(200, score(text))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._json(500, {"error": str(exc)})


def main() -> None:
    load_runtime()
    print(f"[INFO] Serving {MODEL_DIR} on http://{HOST}:{PORT} device={_DEVICE}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
