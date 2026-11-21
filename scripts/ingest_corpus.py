#!/usr/bin/env python3
"""
Download public scam/ham message sources and write normalized JSONL under data/corpus/.

Idempotent: re-run after deleting normalized/*.jsonl to rebuild; raw cache is kept in
data/corpus/raw/ (gitignored).

Optional deps (ingest only):
  pip install datasets huggingface_hub requests

For gated Hugging Face datasets (paulkm/chinese_conversation_and_spam), set HF_TOKEN.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path
from typing import Any, Iterable
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "corpus"
RAW = CORPUS / "raw"
NORMALIZED = CORPUS / "normalized"

UCI_ZIP_URL = "https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip"
UCI_SOURCE_URL = "https://archive.ics.uci.edu/dataset/228/sms+spam+collection"

VANILA_ID = "vanila434/multilingual-elder-safety-msgs"
VANILA_SOURCE_URL = "https://huggingface.co/datasets/vanila434/multilingual-elder-safety-msgs"

PAULKM_ID = "paulkm/chinese_conversation_and_spam"
PAULKM_SOURCE_URL = "https://huggingface.co/datasets/paulkm/chinese_conversation_and_spam"

INGEST_DATE = date.today().isoformat()

URL_RE = re.compile(
    r"https?://[^\s<>\"']+|www\.[^\s<>\"']+",
    re.IGNORECASE,
)
# Light victim-PII redaction for public release (not a substitute for jevlike mask).
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}(?!\d)"
)
HK_PHONE_RE = re.compile(r"(?<!\d)(?:\+852[-.\s]?)?[569]\d{3}[-.\s]?\d{4}(?!\d)")


def stable_id(source: str, key: str) -> str:
    digest = hashlib.sha256(f"{source}|{key}".encode("utf-8")).hexdigest()[:16]
    return f"{source}_{digest}"


def strip_pii(text: str) -> str:
    t = EMAIL_RE.sub("XXX", text)
    t = HK_PHONE_RE.sub("XXX", t)
    t = PHONE_RE.sub("XXX", t)
    return t


def extract_urls(text: str) -> list[str]:
    return URL_RE.findall(text)


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    return n


def uci_dev_split(record_id: str) -> str:
    """Deterministic 10% dev split; disjoint from any project eval sets."""
    bucket = int(hashlib.sha256(record_id.encode()).hexdigest(), 16) % 10
    return "dev" if bucket == 0 else "train"


def download_uci_raw() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    zip_path = RAW / "uci_sms_spam_collection.zip"
    if not zip_path.exists() or zip_path.stat().st_size < 1000:
        print(f"Downloading UCI SMS collection → {zip_path}")
        with urlopen(UCI_ZIP_URL, timeout=120) as resp:
            zip_path.write_bytes(resp.read())
    extract_dir = RAW / "uci_sms"
    collection = extract_dir / "SMSSpamCollection"
    if not collection.exists():
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extract("SMSSpamCollection", path=extract_dir)
    return collection


def normalize_uci() -> list[dict[str, Any]]:
    collection = download_uci_raw()
    rows: list[dict[str, Any]] = []
    with collection.open(encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.rstrip("\n\r")
            if not line or "\t" not in line:
                continue
            label_raw, body = line.split("\t", 1)
            label_raw = label_raw.strip().lower()
            if label_raw == "spam":
                label = "scam"
            elif label_raw == "ham":
                label = "benign"
            else:
                continue
            text = strip_pii(body.strip())
            rid = stable_id("uci_sms", f"line:{line_no}:{body[:64]}")
            urls = extract_urls(text)
            rows.append(
                {
                    "id": rid,
                    "text": text,
                    "label": label,
                    "source": "uci_sms",
                    "source_url": UCI_SOURCE_URL,
                    "license": "research_uci",
                    "collected_at": "2011-03-15",
                    "lang": "en",
                    "has_url": bool(urls),
                    "urls": urls,
                    "split": uci_dev_split(rid),
                    "provenance": "real",
                    "notes": "UCI SMS Spam Collection; spam→scam, ham→benign.",
                }
            )
    return rows


def map_vanila_label(raw: str) -> str | None:
    m = (raw or "").strip().lower()
    if m == "scam":
        return "scam"
    if m == "safe":
        return "benign"
    if m == "ambiguous":
        return "unknown"
    return None


def map_vanila_lang(language: str, script: str) -> str:
    lang = (language or "").strip().lower()
    scr = (script or "").strip().lower()
    if lang == "english":
        return "en"
    if lang == "cantonese":
        return "yue"
    if lang.startswith("code_mixed"):
        return "mixed"
    if lang == "mandarin":
        return "zh-Hant" if scr == "traditional" else "zh-Hans"
    return "unknown"


def vanila_cantonese_focus(row: dict[str, Any]) -> bool:
    language = (row.get("language") or "").lower()
    script = (row.get("script") or "").lower()
    if language in (
        "cantonese",
        "code_mixed_cantonese_english",
        "code_mixed_english_cantonese",
    ):
        return True
    if script == "traditional" and language not in ("english",):
        return True
    return False


def normalize_vanila() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        from datasets import load_dataset
    except ImportError as e:
        raise SystemExit(
            "vanila434 ingest requires: pip install datasets huggingface_hub"
        ) from e

    all_rows: list[dict[str, Any]] = []
    focus_rows: list[dict[str, Any]] = []

    for hf_split, split_name in (("train", "train"), ("holdout", "holdout_public")):
        ds = load_dataset(VANILA_ID, split=hf_split)
        for rec in ds:
            label = map_vanila_label(rec.get("label", ""))
            if label is None:
                continue
            src_id = rec.get("id") or ""
            text_raw = (rec.get("text") or "").strip()
            if not text_raw:
                continue
            text = strip_pii(text_raw)
            rid = stable_id("vanila434", f"{hf_split}:{src_id}:{text_raw[:48]}")
            urls = extract_urls(text)
            out: dict[str, Any] = {
                "id": rid,
                "text": text,
                "label": label,
                "source": "vanila434",
                "source_url": VANILA_SOURCE_URL,
                "license": "cc_by_4",
                "collected_at": INGEST_DATE,
                "lang": map_vanila_lang(rec.get("language", ""), rec.get("script", "")),
                "scam_type": rec.get("sub_type") or rec.get("category"),
                "channel": rec.get("channel"),
                "has_url": bool(urls),
                "urls": urls,
                "split": split_name,
                "provenance": "hand_authored",
                "notes": f"HF id={src_id}; language={rec.get('language')}; script={rec.get('script')}",
            }
            all_rows.append(out)
            if vanila_cantonese_focus(rec):
                focus_rows.append(out)

    return all_rows, focus_rows


def try_normalize_paulkm() -> tuple[list[dict[str, Any]], str | None]:
    """Returns (rows, skip_reason). skip_reason set when dataset unavailable."""
    try:
        from datasets import load_dataset
    except ImportError:
        return [], "missing Python package `datasets` (pip install datasets huggingface_hub)"

    try:
        ds = load_dataset(PAULKM_ID, split="train")
    except Exception as e:
        msg = str(e).lower()
        if "gated" in msg or "authenticated" in msg or "401" in msg:
            return (
                [],
                "gated on Hugging Face; authenticate with HF_TOKEN and re-run ingest",
            )
        return [], f"load failed: {e}"

    rows: list[dict[str, Any]] = []
    for i, rec in enumerate(ds):
        # Schema varies; map common column names without inventing labels.
        text = (
            rec.get("text")
            or rec.get("message")
            or rec.get("content")
            or rec.get("sms")
            or ""
        )
        text = strip_pii(str(text).strip())
        if not text:
            continue
        raw_label = rec.get("label") or rec.get("type") or rec.get("category") or ""
        raw_s = str(raw_label).strip().lower()
        if raw_s in ("spam", "scam", "1", "true"):
            label = "scam"
        elif raw_s in ("ham", "normal", "benign", "safe", "0", "false"):
            label = "benign"
        else:
            label = "unknown"
        rid = stable_id("paulkm", f"row:{i}:{text[:64]}")
        urls = extract_urls(text)
        rows.append(
            {
                "id": rid,
                "text": text,
                "label": label,
                "source": "paulkm",
                "source_url": PAULKM_SOURCE_URL,
                "license": "apache_2",
                "collected_at": INGEST_DATE,
                "lang": "zh-Hans",
                "has_url": bool(urls),
                "urls": urls,
                "split": uci_dev_split(rid),
                "provenance": "real",
                "notes": f"raw_label={raw_label!r}",
            }
        )
    return rows, None


def count_by(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        k = str(r.get(key, "—"))
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items()))


def main() -> int:
    NORMALIZED.mkdir(parents=True, exist_ok=True)
    stats: dict[str, Any] = {"ingested_at": INGEST_DATE, "sources": {}}

    uci = normalize_uci()
    uci_path = NORMALIZED / "uci_sms.jsonl"
    stats["sources"]["uci_sms"] = {
        "path": str(uci_path.relative_to(ROOT)),
        "count": write_jsonl(uci_path, uci),
        "label": count_by(uci, "label"),
        "split": count_by(uci, "split"),
        "license": "research_uci",
    }

    vanila, vanila_focus = normalize_vanila()
    vanila_path = NORMALIZED / "vanila434_elder_safety.jsonl"
    focus_path = NORMALIZED / "cantonese_focus.jsonl"
    stats["sources"]["vanila434"] = {
        "path": str(vanila_path.relative_to(ROOT)),
        "count": write_jsonl(vanila_path, vanila),
        "cantonese_focus_path": str(focus_path.relative_to(ROOT)),
        "cantonese_focus_count": write_jsonl(focus_path, vanila_focus),
        "label": count_by(vanila, "label"),
        "split": count_by(vanila, "split"),
        "license": "cc_by_4",
    }

    paulkm_rows, paulkm_skip = try_normalize_paulkm()
    if paulkm_rows:
        paulkm_path = NORMALIZED / "paulkm_chinese_spam.jsonl"
        stats["sources"]["paulkm"] = {
            "path": str(paulkm_path.relative_to(ROOT)),
            "count": write_jsonl(paulkm_path, paulkm_rows),
            "label": count_by(paulkm_rows, "label"),
            "license": "apache_2",
        }
    else:
        stats["sources"]["paulkm"] = {"skipped": True, "reason": paulkm_skip}

    # Combined train/dev: only rows explicitly marked train or dev (never holdout_public).
    combined_train: list[dict[str, Any]] = []
    combined_dev: list[dict[str, Any]] = []
    for row in uci + vanila + paulkm_rows:
        sp = row.get("split")
        if sp == "train":
            combined_train.append(row)
        elif sp == "dev":
            combined_dev.append(row)

    train_path = NORMALIZED / "combined_train.jsonl"
    dev_path = NORMALIZED / "combined_dev.jsonl"
    stats["combined"] = {
        "train": write_jsonl(train_path, combined_train),
        "dev": write_jsonl(dev_path, combined_dev),
    }

    manifest = CORPUS / "ingest_stats.json"
    manifest.write_text(json.dumps(stats, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
