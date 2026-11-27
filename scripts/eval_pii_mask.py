#!/usr/bin/env python3
"""Evaluate a trained PII mask checkpoint against fixed recall/overmasking cases.

Requires the frozen HF encoder and a PII checkpoint, so this is a local lab tool
rather than part of the offline unit-test suite.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>\"'）)】]+", re.I)


def utf16_width(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def unit_positions(text: str, start: int, end: int, skip_space: bool = True) -> set[int]:
    positions: set[int] = set()
    unit = 0
    for index, char in enumerate(text):
        width = utf16_width(char)
        if start <= index < end and not (skip_space and char.isspace()):
            positions.update(range(unit, unit + width))
        unit += width
    return positions


def all_nonspace_positions(text: str) -> set[int]:
    return unit_positions(text, 0, len(text), skip_space=True)


def secret_positions(text: str, secret: str) -> set[int]:
    start = text.index(secret)
    return unit_positions(text, start, start + len(secret), skip_space=True)


def url_positions(text: str) -> set[int]:
    positions: set[int] = set()
    for match in URL_RE.finditer(text):
        positions.update(unit_positions(text, match.start(), match.end(), skip_space=False))
    return positions


def mask_text_utf16(text: str, spans: list[dict]) -> str:
    raw = text.encode("utf-16-le")
    masked = raw
    token = "XXX".encode("utf-16-le")
    for span in sorted(spans, key=lambda item: item["start"], reverse=True):
        masked = masked[: span["start"] * 2] + token + masked[span["end"] * 2 :]
    return masked.decode("utf-16-le", errors="replace")


def evaluate(checkpoint: Path, fixture: Path, threshold: float | None = None) -> dict:
    import jevlike_serve as serve

    os.environ["JEVLIKE_MASK_CKPT"] = str(checkpoint)
    serve.load_runtime()
    if threshold is not None:
        serve._MASK_THRESHOLD = threshold
    cases = json.loads(fixture.read_text(encoding="utf-8"))["cases"]
    rows = []
    all_gold: set[tuple[int, int]] = set()
    all_pred: set[tuple[int, int]] = set()
    full = partial = missed = 0
    for case_index, case in enumerate(cases):
        text = case["text"]
        started = time.perf_counter()
        spans = serve.model_mask_spans(text)
        elapsed_ms = (time.perf_counter() - started) * 1000
        gold: set[int] = set()
        for secret in case.get("expect", []):
            gold.update(secret_positions(text, secret))
        pred: set[int] = set()
        for span in spans:
            pred.update(range(int(span["start"]), int(span["end"])))
        pred &= all_nonspace_positions(text)
        measurable_pred = set(pred)
        if case.get("allow_url_overmask"):
            measurable_pred -= url_positions(text) - gold
        all_gold.update((case_index, pos) for pos in gold)
        all_pred.update((case_index, pos) for pos in measurable_pred)
        secret_rows = []
        for secret in case.get("expect", []):
            positions = secret_positions(text, secret)
            coverage = len(positions & pred) / len(positions) if positions else 1.0
            status = "full" if coverage == 1.0 else ("partial" if coverage else "missed")
            if status == "full":
                full += 1
            elif status == "partial":
                partial += 1
            else:
                missed += 1
            secret_rows.append(
                {"secret": secret, "coverage": round(coverage, 4), "status": status}
            )
        rows.append(
            {
                "id": case["id"],
                "kind": case["kind"],
                "text": text,
                "spans": spans,
                "masked": mask_text_utf16(text, spans),
                "ms": round(elapsed_ms, 2),
                "gold_chars": len(gold),
                "pred_chars": len(measurable_pred),
                "fp_chars": len(measurable_pred - gold),
                "fn_chars": len(gold - measurable_pred),
                "secrets": secret_rows,
            }
        )
    tp = len(all_gold & all_pred)
    fp = len(all_pred - all_gold)
    fn = len(all_gold - all_pred)
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    negatives = [row for row in rows if row["kind"] == "negative"]
    return {
        "checkpoint": str(checkpoint),
        "fixture": str(fixture),
        "threshold": serve._MASK_THRESHOLD,
        "overall": {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "tp": tp,
            "fp": fp,
            "fn": fn,
        },
        "secrets": {
            "full": full,
            "partial": partial,
            "missed": missed,
            "total": full + partial + missed,
        },
        "hard_negatives": {
            "clean": sum(1 for row in negatives if not row["spans"]),
            "flagged": sum(1 for row in negatives if row["spans"]),
            "total": len(negatives),
        },
        "latency_ms": {
            "mean": round(sum(row["ms"] for row in rows) / len(rows), 2),
            "max": max(row["ms"] for row in rows),
        },
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=ROOT / "models" / "jevlike_hf_pii_mask.pt")
    parser.add_argument("--fixture", type=Path, default=ROOT / "fixtures" / "pii-mask-eval.json")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--threshold", type=float)
    args = parser.parse_args()
    result = evaluate(args.checkpoint, args.fixture, args.threshold)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
