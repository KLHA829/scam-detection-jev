#!/usr/bin/env python3
"""Persistent HF-encoder jevlike scoring worker (Pi / CPU friendly).

Loads a small jevlike head checkpoint (~2 MB) once and the frozen Hugging Face
encoder (`hfl/chinese-roberta-wwm-ext` by default) from the Hub on first run.
The encoder is NOT shipped in git.

POST /v1/score  {"text":"..."} -> {prob_scam, prob_not_scam, label, score}
POST /predict   same body (or {"context","options"})
POST /v1/mask   {"messages":["..."]} -> {messages:[{spans:[{start,end,label}]}]}
GET  /health

/v1/mask does not use the scam choice head. Spans come only from the
separate PII AttentionHead. Without that checkpoint the route returns 503
and the bot does not send the text. find_mask_spans remains the training
label helper; it is not applied to this response. The caller replaces the
spans; this response never echoes the source text.
"""
from __future__ import annotations

import json
import os
import re
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


def env_str(name: str, default: str) -> str:
    """Blank systemd Environment= lines are empty strings, not unset."""
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip()


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return int(str(raw).strip())


RELEASE_TAG = "jevlike-hf-r1"
RELEASE_ASSET = "jevlike_hf_chinese_roberta_r1.pt"
RELEASE_DOWNLOAD_URL = (
    "https://github.com/KLHA829/scam-detection-jev/releases/download/"
    f"{RELEASE_TAG}/{RELEASE_ASSET}"
)
ENCODER_DOWNLOAD_NOTE = (
    "[WARN] First run downloads the frozen HF encoder "
    f"{DEFAULT_ENCODER} (~400 MB) into the Hugging Face cache. "
    "On a Raspberry Pi this can take several minutes and needs disk + RAM."
)

# Precision-first head published on jevlike-hf-r1. Without JEVLIKE_CKPT we load
# only this file — never older heads such as hf_chinese_roberta_hn800.pt.
DEFAULT_CKPT = ROOT / "models" / "jevlike_hf_chinese_roberta_r1.pt"

DEVICE = os.environ.get("JEVLIKE_DEVICE", "cpu")
HOST = env_str("JEVLIKE_HOST", DEFAULT_HOST)
PORT = env_int("JEVLIKE_PORT", DEFAULT_PORT)
API_KEY = os.environ.get("JEVLIKE_API_KEY", "")
MAX_BODY = env_int("JEVLIKE_MAX_BODY", 65536)

_MODEL = None
_COLLATOR = None
_CONFIG: dict | None = None
_CHECKPOINT_PATH = None
_ENCODER_ID = None
_OPTIONS: tuple[str, ...] = DEFAULT_OPTIONS
_DEVICE = None
_SCORE_LOCK = threading.Lock()
_MASK_HEAD = None
_MASK_THRESHOLD = 0.5
_MASK_CFG: dict | None = None
_MASK_PATH: Path | None = None
_MASK_OPTION_CACHE = None
DEFAULT_MASK_CKPT = ROOT / "models" / "jevlike_hf_pii_mask.pt"


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
    if DEFAULT_CKPT.is_file():
        return DEFAULT_CKPT
    raise FileNotFoundError(
        f"jevlike r1 checkpoint not found: {DEFAULT_CKPT}. Download "
        f"{RELEASE_DOWNLOAD_URL} into models/ "
        "or set JEVLIKE_CKPT. See models/README.md "
        "and scripts/download_jevlike_ckpt.sh."
    )


def load_runtime() -> None:
    global _MODEL, _COLLATOR, _CONFIG, _CHECKPOINT_PATH, _ENCODER_ID, _OPTIONS, _DEVICE
    import torch
    from jevlike.model import make_system

    _OPTIONS = parse_options(os.environ.get("JEVLIKE_OPTIONS"))
    _CHECKPOINT_PATH = resolve_checkpoint()
    print(ENCODER_DOWNLOAD_NOTE, file=sys.stderr, flush=True)

    payload = torch.load(_CHECKPOINT_PATH, map_location="cpu", weights_only=True)
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
    try:
        maybe_load_mask_head()
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] pii mask head not loaded: {exc}", file=sys.stderr, flush=True)


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


_SURNAME = (
    "陳李黃張劉周吳鄭王何梁馬羅蔡楊許謝郭洪曾邱廖賴徐朱葉沈韓馮鄧曹彭鍾蔣蕭潘譚汪陸蘇盧唐孫魏方石余姚戴宋范杜丁傅江夏高林胡袁于董程呂阮莊簡連康雷畢翁游伍古屈甄聶湯岑霍龍莫嚴龔區丘韋麥尹駱黎尤"
)
_ORG_TAIL = "會|公司|中心|銀行|部門|職員|客戶|集團|機構|協會|基金|學校|醫院|警署|政府"
_COMPOUND = "歐陽|司馬|上官|諸葛|令狐|皇甫|慕容|司徒|軒轅"
_ROLE = "經理|主任|董事|總監|監事|專員|助理|顧問|律師|醫生|老師|警官|隊長|組長|文員|店長|小姐|先生|太太"
_NAME_TOKEN = (
    f"(?:(?:{_COMPOUND})[\\u4e00-\\u9fff]{{1,2}}"
    f"|[{_SURNAME}](?!{_ORG_TAIL})(?!{_ROLE})[\\u4e00-\\u9fff]{{1,2}}"
    f"|阿[\\u4e00-\\u9fff])"
)
_NAME_RE = re.compile(
    "(我[係是]|本人)"
    "(?!防騙|防骗|反詐|反诈|銀行|银行|警察|公安|官方|協調|协调|客服|職員|职员|新聞|新闻|政府|入境|海關|海关|順豐|顺丰|whatsapp)"
    f"({_NAME_TOKEN})"
)
# ASCII edges, matching JavaScript \b. Digit atoms are [0-9], matching
# JavaScript \d. re.ASCII stays off so \s and \S stay wide.
_W_BEFORE = r"(?<![A-Za-z0-9_])"
_W_AFTER = r"(?![A-Za-z0-9_])"
_MASK_RULES: tuple[tuple[str, re.Pattern[str], int], ...] = (
    (
        "email",
        re.compile(
            _W_BEFORE + r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}" + _W_AFTER,
            re.I,
        ),
        False,
    ),
    (
        "id",
        re.compile(
            _W_BEFORE + r"[A-Z]{1,2}[0-9]{6}\s*\(?[0-9A]\)?" + _W_AFTER,
            re.I,
        ),
        False,
    ),
    ("id", re.compile(_W_BEFORE + r"[0-9]{17}[0-9Xx]" + _W_AFTER), False),
    (
        "phone",
        re.compile(r"(?:\+|00)?852[\s-]*[45679][0-9]{3}[\s-]?[0-9]{4}" + _W_AFTER),
        False,
    ),
    ("phone", re.compile(r"(?<![0-9])[45679][0-9]{3}[\s-]?[0-9]{4}(?![0-9])"), False),
    ("phone", re.compile(r"(?<![0-9])(?:\+?[0-9][0-9\s-]{7,20}[0-9])(?![0-9])"), False),
    ("account", re.compile(r"(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])"), False),
    (
        "account",
        re.compile(
            r"(?:戶口|户口|帳號|账号|帳戶|账户|卡號|卡号|a/c(?:\s*no\.?)?|account(?:\s*(?:no\.?|number))?)"
            r"\s*[:：#]?\s*([0-9\s-]{6,24})",
            re.I,
        ),
        1,
    ),
    (
        "account",
        re.compile(
            rf"(?:{_W_BEFORE}payme{_W_AFTER}|轉數快|转数快|{_W_BEFORE}fps{_W_AFTER})"
            r"(?:\s*(?:id|號碼|号码|戶口|户口|帳號|账号))?\s*[:：#]?\s*(?!https?://)([A-Z0-9._+-]{4,32}|[0-9]{4}\s+[0-9]{4})",
            re.I,
        ),
        1,
    ),
)
_OTP_NEAR = re.compile(
    rf"(?:驗證碼|验证码|一次性密碼|一次性密码|密碼|密码|{_W_BEFORE}code{_W_AFTER}|{_W_BEFORE}otp{_W_AFTER})"
    r"[^0-9]{0,16}([0-9]{4,8})(?![0-9])",
    re.I,
)
_OTP_BARE = re.compile(r"(?<![0-9])[0-9]{6,8}(?![0-9])")
_URL_RE = re.compile(r"https?://[^\s<>\"'）)】]+", re.I)
_WWW_RE = re.compile(_W_BEFORE + r"www\.[^\s<>\"'）)】]+", re.I)
_SHORT_RE = re.compile(
    _W_BEFORE + r"((?:wa\.me|t\.me|bit\.ly|tinyurl\.com)/)([A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)",
    re.I,
)
_MASK_MESSAGE_CAP = 10
_MASK_WINDOW_BATCH = 16
_MAX_MASK_WINDOWS = 128


def _spans_from_regex(
    text: str,
    pattern: re.Pattern[str],
    label: str,
    group: int = 0,
) -> list[dict]:
    spans = []
    for match in pattern.finditer(text):
        if group:
            if match.group(group) is None:
                continue
            start, end = match.start(group), match.end(group)
        else:
            start, end = match.start(), match.end()
        if end > start:
            spans.append({"start": start, "end": end, "label": label})
    return spans


def _otp_spans(text: str) -> list[dict]:
    return _spans_from_regex(text, _OTP_NEAR, "otp", 1) + _spans_from_regex(
        text, _OTP_BARE, "otp", 0
    )


def _url_authority_bounds(raw: str) -> tuple[int, int, int, int] | None:
    scheme_at = raw.find("://")
    user_at = scheme_at + 3 if scheme_at >= 0 else 0
    path_at = len(raw)
    for delim in ("/", "?", "#"):
        idx = raw.find(delim, user_at)
        if idx >= 0 and idx < path_at:
            path_at = idx
    authority = raw[user_at:path_at]
    if not authority:
        return None
    at_rel = authority.rfind("@")
    at = user_at + at_rel if at_rel >= 0 else -1
    host_start = at + 1 if at >= 0 else user_at
    if host_start >= path_at:
        return None
    return user_at, at, host_start, path_at


def _url_spans(text: str) -> list[dict]:
    from urllib.parse import urlparse

    spans = []
    for pattern in (_URL_RE, _WWW_RE):
        for match in pattern.finditer(text):
            raw = match.group(0)
            parsed = urlparse(raw if "://" in raw else f"https://{raw}")
            bounds = _url_authority_bounds(raw) if parsed.hostname else None
            if bounds is None:
                spans.append({"start": match.start(), "end": match.end(), "label": "url"})
                continue
            user_at, at, _host_start, path_at = bounds
            if at > user_at:
                spans.append(
                    {
                        "start": match.start() + user_at,
                        "end": match.start() + at,
                        "label": "url",
                    }
                )
            if path_at < len(raw):
                spans.append(
                    {
                        "start": match.start() + path_at,
                        "end": match.end(),
                        "label": "url",
                        "replacement": " XXX",
                    }
                )
    for match in _SHORT_RE.finditer(text):
        prefix, secret = match.group(1), match.group(2)
        if secret:
            start = match.start() + len(prefix)
            spans.append({"start": start, "end": start + len(secret), "label": "url"})
    return spans


def _name_spans(text: str) -> list[dict]:
    spans = []
    for match in _NAME_RE.finditer(text):
        name = match.group(2) or ""
        prefix = match.group(1) or ""
        if name:
            start = match.start() + len(prefix)
            spans.append({"start": start, "end": start + len(name), "label": "name"})
    return spans


def merge_mask_spans(spans: list[dict]) -> list[dict]:
    ordered = sorted(
        (
            span
            for span in spans
            if isinstance(span, dict)
            and isinstance(span.get("start"), int)
            and isinstance(span.get("end"), int)
            and span["end"] > span["start"]
        ),
        key=lambda span: (span["start"], -(span["end"] - span["start"])),
    )
    merged: list[dict] = []
    for span in ordered:
        if merged and span["start"] < merged[-1]["end"]:
            if span["end"] > merged[-1]["end"]:
                merged[-1]["end"] = span["end"]
            continue
        item = {
            "start": span["start"],
            "end": span["end"],
            "label": span.get("label") or "pii",
        }
        if span.get("replacement"):
            item["replacement"] = span["replacement"]
        merged.append(item)
    return merged


def find_mask_spans(text: str) -> list[dict]:
    """Training-label ranges. Live /v1/mask does not call this."""
    body = "" if text is None else str(text)
    if not body:
        return []
    spans: list[dict] = []
    for label, pattern, group in _MASK_RULES:
        spans.extend(_spans_from_regex(body, pattern, label, group))
    spans.extend(_otp_spans(body))
    spans.extend(_url_spans(body))
    spans.extend(_name_spans(body))
    return merge_mask_spans(spans)


def resolve_mask_checkpoint() -> Path | None:
    spec = os.environ.get("JEVLIKE_MASK_CKPT", "").strip()
    if spec:
        path = Path(spec).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"JEVLIKE_MASK_CKPT not found: {path}")
        return path
    if DEFAULT_MASK_CKPT.is_file():
        return DEFAULT_MASK_CKPT
    return None


def maybe_load_mask_head() -> None:
    """Load the PII AttentionHead onto the scorer's frozen encoder. Optional."""
    global _MASK_HEAD, _MASK_THRESHOLD, _MASK_CFG, _MASK_PATH
    if _MODEL is None:
        return
    path = resolve_mask_checkpoint()
    if path is None:
        print("[INFO] no pii mask head; /v1/mask refuses until one is loaded", flush=True)
        return
    import torch
    from jevlike.model import AttentionHead

    from pii_mask_head import head_state_from_checkpoint

    payload = torch.load(path, map_location="cpu", weights_only=True)
    config = payload.get("config") or {}
    if config.get("task") != "pii_mask":
        raise ValueError(f"{path} is not a pii_mask checkpoint")
    hidden = int(_MODEL.encoder.config.hidden_size)
    rank = int(config.get("rank") or 32)
    head = AttentionHead(hidden, rank)
    head.load_state_dict(head_state_from_checkpoint(payload["state_dict"]), strict=True)
    head.to(_DEVICE).eval()
    _MASK_HEAD = head
    _MASK_THRESHOLD = float(config.get("mask_threshold", 0.5))
    _MASK_CFG = config
    _MASK_PATH = path
    print(
        f"[OK] pii mask head loaded checkpoint={path} threshold={_MASK_THRESHOLD} rank={rank}",
        flush=True,
    )


def _sanitize_surrogates(text: str) -> str:
    if not text:
        return ""
    # Replace lone UTF-16 surrogates 1:1 with U+FFFD so code-unit length stays identical.
    return "".join("\ufffd" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in text)


def _utf16_units(text: str) -> int:
    return len(_sanitize_surrogates(text).encode("utf-16-le")) // 2


def _to_utf16_spans(text: str, spans: list[dict]) -> list[dict]:
    """Python indexes are code points. The bot slices UTF-16 code units."""
    if not spans:
        return []
    safe_text = _sanitize_surrogates(text)
    prefixes = [0]
    total = 0
    for ch in safe_text:
        total += _utf16_units(ch)
        prefixes.append(total)
    converted = []
    limit = len(prefixes) - 1
    for span in spans:
        start = span.get("start")
        end = span.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            continue
        if start < 0 or end > limit or end <= start:
            continue
        item = dict(span)
        item["start"] = prefixes[start]
        item["end"] = prefixes[end]
        converted.append(item)
    return converted


class MaskTruncated(Exception):
    """Tokenizer windows left characters uncovered. A 200 would leave them unmarked."""


def _gap_has_tokens(slice_text: str, tokenizer) -> bool:
    if not slice_text:
        return False
    if tokenizer is None:
        return True
    return tokenizer(slice_text, add_special_tokens=False, return_tensors="pt")["input_ids"].numel() > 0


def mask_coverage_truncated(text: str, offsets, tokenizer=None) -> bool:
    """True when tokenizer offsets leave non-tokenless interior gaps or tail uncovered.

    With a tokenizer, an uncovered slice that yields no tokens (spaces, an emoji
    variation selector) is not truncation: the model never sees those characters.
    """
    body = "" if text is None else str(text)
    if not body:
        return False
    intervals = []
    for span in offsets or []:
        try:
            start = int(span[0])
            end = int(span[1])
        except (TypeError, ValueError, IndexError):
            continue
        if end > start:
            intervals.append((max(0, start), min(len(body), end)))
    if not intervals:
        return _gap_has_tokens(body, tokenizer)
    intervals.sort()
    covered = 0
    for start, end in intervals:
        if start > covered and _gap_has_tokens(body[covered:start], tokenizer):
            return True
        covered = max(covered, end)
    if covered < len(body) and _gap_has_tokens(body[covered:], tokenizer):
        return True
    return False


def model_mask_spans_batch(texts: list[str]) -> list[list[dict]]:
    """Character spans for a batch of messages from the fine-tuned mask head."""
    global _MASK_OPTION_CACHE
    if _MASK_HEAD is None or _MODEL is None or _COLLATOR is None or _DEVICE is None:
        return [[] for _ in texts]
    if not texts:
        return []
    import torch

    from pii_mask_head import (
        MASK_OPTION,
        KEEP_OPTION,
        flags_from_window_offsets,
        mask_option_logits,
        pool_token_hidden,
        spans_from_flags,
    )

    tokenizer = _COLLATOR.tokenizer
    limit = 96
    if _MASK_CFG and _MASK_CFG.get("context_tokens"):
        limit = max(8, int(_MASK_CFG["context_tokens"]))
    stride = max(1, limit // 2)
    mask_option = (_MASK_CFG or {}).get("mask_option") or MASK_OPTION
    keep_option = (_MASK_CFG or {}).get("keep_option") or KEEP_OPTION
    padding_side = getattr(tokenizer, "padding_side", "right")

    prepared = []
    windows = []
    for text in texts:
        safe_text = _sanitize_surrogates("" if text is None else str(text))
        # Long messages are split into overlapping windows of the trained context length,
        # so every character is scored instead of the tail being dropped.
        encoded = tokenizer(
            safe_text,
            truncation=True,
            max_length=limit,
            stride=stride,
            return_overflowing_tokens=True,
            padding=True,
            add_special_tokens=True,
            return_offsets_mapping=True,
            return_tensors="pt",
        )
        n_windows = int(encoded["input_ids"].shape[0])
        if n_windows > _MAX_MASK_WINDOWS:
            raise ValueError("message too long")
        window_offsets = encoded["offset_mapping"].detach().cpu().tolist()
        flat_offsets = [span for window in window_offsets for span in window]
        if mask_coverage_truncated(safe_text, flat_offsets, tokenizer):
            raise MaskTruncated("mask truncated")

        input_ids = encoded["input_ids"].detach().cpu()
        attention_mask = encoded["attention_mask"].detach().cpu()
        first_window = len(windows)
        trimmed_window_offsets = []
        for row in range(n_windows):
            width = int(attention_mask[row].sum().item())
            if width <= 0:
                width = int(input_ids[row].shape[0])
            if padding_side == "left":
                row_ids = input_ids[row, -width:].clone()
                row_mask = attention_mask[row, -width:].clone()
                row_offsets = window_offsets[row][-width:]
            else:
                row_ids = input_ids[row, :width].clone()
                row_mask = attention_mask[row, :width].clone()
                row_offsets = window_offsets[row][:width]
            windows.append({"input_ids": row_ids, "attention_mask": row_mask, "width": width})
            trimmed_window_offsets.append(row_offsets)
        prepared.append(
            {
                "safe_text": safe_text,
                "window_offsets": trimmed_window_offsets,
                "first_window": first_window,
                "window_count": n_windows,
            }
        )

    option_key = (_MODEL.encoder, tokenizer, _DEVICE, mask_option, keep_option)
    flat_probs: list[list[float]] = []
    with _SCORE_LOCK:
        with torch.no_grad():
            if _MASK_OPTION_CACHE is None or _MASK_OPTION_CACHE[0] != option_key:
                options = tokenizer(
                    [mask_option, keep_option],
                    truncation=True,
                    max_length=16,
                    add_special_tokens=True,
                    return_tensors="pt",
                    padding=True,
                )
                options = {key: value.to(_DEVICE) for key, value in options.items()}
                option_hidden = _MODEL.encoder(
                    input_ids=options["input_ids"],
                    attention_mask=options["attention_mask"],
                ).last_hidden_state
                pooled = pool_token_hidden(option_hidden, options["attention_mask"].bool())
                _MASK_OPTION_CACHE = (option_key, pooled)
            pooled = _MASK_OPTION_CACHE[1]
            pad_id = tokenizer.pad_token_id if getattr(tokenizer, "pad_token_id", None) is not None else 0
            for start in range(0, len(windows), _MASK_WINDOW_BATCH):
                chunk = windows[start : start + _MASK_WINDOW_BATCH]
                width = max(item["width"] for item in chunk)
                batch_ids = torch.full(
                    (len(chunk), width),
                    pad_id,
                    dtype=chunk[0]["input_ids"].dtype,
                )
                batch_mask = torch.zeros(
                    (len(chunk), width),
                    dtype=chunk[0]["attention_mask"].dtype,
                )
                for row, item in enumerate(chunk):
                    if padding_side == "left":
                        batch_ids[row, width - item["width"] :] = item["input_ids"]
                        batch_mask[row, width - item["width"] :] = item["attention_mask"]
                    else:
                        batch_ids[row, : item["width"]] = item["input_ids"]
                        batch_mask[row, : item["width"]] = item["attention_mask"]
                context_hidden = _MODEL.encoder(
                    input_ids=batch_ids.to(_DEVICE),
                    attention_mask=batch_mask.to(_DEVICE),
                ).last_hidden_state
                logits = mask_option_logits(_MASK_HEAD, context_hidden, pooled)
                probabilities = torch.sigmoid(logits).detach().cpu()
                for row, item in enumerate(chunk):
                    if padding_side == "left":
                        row_probs = probabilities[row, width - item["width"] :]
                    else:
                        row_probs = probabilities[row, : item["width"]]
                    flat_probs.append(row_probs.tolist())

    results = []
    for item in prepared:
        first = item["first_window"]
        stop = first + item["window_count"]
        window_probs = flat_probs[first:stop]
        flags = flags_from_window_offsets(
            item["safe_text"],
            item["window_offsets"],
            window_probs,
            _MASK_THRESHOLD,
        )
        results.append(_to_utf16_spans(item["safe_text"], spans_from_flags(item["safe_text"], flags)))
    return results


def model_mask_spans(text: str) -> list[dict]:
    """Character spans from the fine-tuned mask head. Empty when it is not loaded."""
    return model_mask_spans_batch([text])[0]


def mask_payload(messages: list) -> dict:
    if len(messages) > _MASK_MESSAGE_CAP:
        raise ValueError("at most 10 messages")
    if _MASK_HEAD is None:
        raise RuntimeError("pii mask head is not loaded")
    if any(not isinstance(item, str) for item in messages):
        raise ValueError("message must be a string")
    rows = [{"spans": spans} for spans in model_mask_spans_batch(messages)]
    return {
        "ok": True,
        "model": "jevlike",
        "method": "jevlike_pii_head",
        "messages": rows,
    }


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not API_KEY:
        return True
    header = handler.headers.get("Authorization", "")
    return header == f"Bearer {API_KEY}"


class Handler(BaseHTTPRequestHandler):
    timeout = 30

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
                "pii_mask": _MASK_HEAD is not None,
                "pii_mask_threshold": _MASK_THRESHOLD if _MASK_HEAD is not None else None,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if not authorized(self):
            self._send(401, {"error": "unauthorized"})
            return
        path = self.path.split("?", 1)[0]
        if path not in ("/predict", "/v1/score", "/score", "/v1/mask"):
            self._send(404, {"error": "not found"})
            return
        if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
            self._send(411, {"error": "length_required"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self._send(400, {"error": "bad_content_length"})
            return
        if length < 0:
            self._send(400, {"error": "bad_content_length"})
            return
        if length > MAX_BODY:
            self._send(413, {"error": "payload_too_large"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send(422, {"error": "invalid json"})
            return
        if not isinstance(payload, dict):
            self._send(422, {"error": "body must be an object"})
            return
        if path == "/v1/mask":
            messages = payload.get("messages")
            if messages is None and isinstance(payload.get("text"), str):
                messages = [payload["text"]]
            if not isinstance(messages, list):
                self._send(422, {"error": "messages must be a list"})
                return
            try:
                self._send(200, mask_payload(messages))
            except ValueError as exc:
                self._send(422, {"error": str(exc)})
            except RuntimeError:
                self._send(503, {"error": "pii mask head is not loaded"})
            except Exception:
                traceback.print_exc()
                self._send(500, {"error": "mask failed"})
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


def warn_if_open_bind(host: str) -> None:
    if host in ("127.0.0.1", "localhost", "::1"):
        return
    if API_KEY:
        return
    print(
        f"[WARN] jevlike is listening on {host} without JEVLIKE_API_KEY. "
        "Message text posted to /v1/score and /v1/mask is unauthenticated.",
        file=sys.stderr,
        flush=True,
    )


def main() -> None:
    load_runtime()
    warn_if_open_bind(HOST)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"[INFO] jevlike worker listening on http://{HOST}:{PORT}/v1/score",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
