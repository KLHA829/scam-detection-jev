#!/usr/bin/env python3
"""Score vendored eval JSONL corpora with the jevlike r1 head and report metrics.

Requires torch + jevlike (see requirements.txt) and a downloaded r1 checkpoint
(scripts/download_jevlike_ckpt.sh). Uses the same thresholds as scoring-rubric.json.

Usage:
  .venv/bin/python scripts/eval_jevlike.py
  .venv/bin/python scripts/eval_jevlike.py --write-baseline evals/baselines/r1-hk50-data_v2-test.json

If JEVLIKE_BASE_URL is set and torch is unavailable, scores via HTTP against a
running jevlike_serve.py worker instead.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CORPORA = (
    ("hk50", ROOT / "evals" / "hk50" / "hk50_real_eval.jsonl"),
    ("data_v2_test", ROOT / "evals" / "data_v2" / "test.jsonl"),
)
RUBRIC_PATH = ROOT / "scoring-rubric.json"
RELEASE_TAG = "jevlike-hf-r1"


@dataclass(frozen=True)
class Row:
    row_id: str
    text: str
    label: str  # scam | not_scam


def load_thresholds() -> dict[str, float]:
    raw = json.loads(RUBRIC_PATH.read_text(encoding="utf-8"))
    th = raw.get("thresholds") or {}
    archive = float(os.environ.get("ARCHIVE_THRESHOLD", th.get("archive", 42)))
    block = float(os.environ.get("BLOCK_THRESHOLD", th.get("block", 80)))
    safe = float(os.environ.get("SAFE_THRESHOLD", th.get("safe", 18)))
    return {"archive": archive, "block": block, "safe": safe}


def read_jsonl(path: Path) -> list[Row]:
    rows: list[Row] = []
    with path.open(encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            label = str(obj.get("label", "")).strip().lower()
            if label not in ("scam", "not_scam"):
                raise ValueError(f"{path}:{line_no}: label must be scam|not_scam, got {label!r}")
            text = obj.get("text")
            if text is None or not str(text).strip():
                raise ValueError(f"{path}:{line_no}: missing text")
            row_id = str(obj.get("id") or f"line_{line_no}")
            rows.append(Row(row_id=row_id, text=str(text), label=label))
    if not rows:
        raise ValueError(f"{path}: no rows")
    return rows


def line_metrics(
    labels: Iterable[str],
    scores: Iterable[float],
    threshold: float,
) -> dict[str, Any]:
    tp = fp = fn = tn = 0
    for label, score in zip(labels, scores, strict=True):
        pred_pos = score >= threshold
        actual_pos = label == "scam"
        if actual_pos and pred_pos:
            tp += 1
        elif actual_pos and not pred_pos:
            fn += 1
        elif not actual_pos and pred_pos:
            fp += 1
        else:
            tn += 1
    n_scam = tp + fn
    n_innocent = fp + tn
    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    fp_rate_innocents = fp / n_innocent if n_innocent else None
    return {
        "threshold": threshold,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "n_scam": n_scam,
        "n_innocent": n_innocent,
        "precision": precision,
        "recall": recall,
        "fp_rate_on_innocents": fp_rate_innocents,
        "fp_on_innocents": f"{fp}/{n_innocent}" if n_innocent else "0/0",
        "fn_on_scams": f"{fn}/{n_scam}" if n_scam else "0/0",
    }


def make_scorer_via_runtime() -> Callable[[str], float]:
    # Import after argparse so --help works without torch on PATH.
    sys.path.insert(0, str(ROOT))
    import jevlike_serve  # noqa: WPS433

    jevlike_serve.load_runtime()
    return lambda text: float(jevlike_serve.score_text(text)["score"])


def make_scorer_via_http(base_url: str) -> Callable[[str], float]:
    base = base_url.rstrip("/")
    score_url = base if base.endswith("/v1/score") else f"{base}/v1/score"

    def score(text: str) -> float:
        body = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            score_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"HTTP score failed: {exc}") from exc
        if not payload.get("ok", True):
            raise RuntimeError(f"score error: {payload}")
        score_val = payload.get("score")
        if score_val is None and isinstance(payload.get("prob_scam"), (int, float)):
            score_val = float(payload["prob_scam"]) * 100.0
        return float(score_val)

    return score


def resolve_scorer() -> tuple[Callable[[str], float], str]:
    base_url = (os.environ.get("JEVLIKE_BASE_URL") or "").strip()
    if base_url:
        return make_scorer_via_http(base_url), f"http:{base_url}"
    try:
        return make_scorer_via_runtime(), "in_process"
    except ImportError as exc:
        if base_url:
            raise
        raise SystemExit(
            "torch/jevlike not installed. Create .venv, pip install -r requirements.txt, "
            "or set JEVLIKE_BASE_URL to a running jevlike_serve.py worker."
        ) from exc


def evaluate_corpus(name: str, path: Path, score_fn: Callable[[str], float]) -> dict[str, Any]:
    rows = read_jsonl(path)
    labels = [r.label for r in rows]
    scores = [score_fn(r.text) for r in rows]
    thresholds = load_thresholds()
    archive = line_metrics(labels, scores, thresholds["archive"])
    block = line_metrics(labels, scores, thresholds["block"])
    return {
        "name": name,
        "path": str(path.relative_to(ROOT)),
        "n": len(rows),
        "labels": {"scam": labels.count("scam"), "not_scam": labels.count("not_scam")},
        "archive_line": archive,
        "block_line_score_only": {
            **block,
            "note": (
                "Score ≥ block threshold only; the bot does not auto-block on score alone "
                "(unsaved block = link rule or explicit context-model block)."
            ),
        },
    }


def combined_metrics(corpora: list[dict[str, Any]], key: str) -> dict[str, Any]:
    tp = fp = fn = tn = 0
    for c in corpora:
        m = c[key]
        tp += m["tp"]
        fp += m["fp"]
        fn += m["fn"]
        tn += m["tn"]
    n_scam = tp + fn
    n_innocent = fp + tn
    th = corpora[0][key]["threshold"] if corpora else 0
    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    fp_rate = fp / n_innocent if n_innocent else None
    return {
        "threshold": th,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "n_scam": n_scam,
        "n_innocent": n_innocent,
        "precision": precision,
        "recall": recall,
        "fp_rate_on_innocents": fp_rate,
        "fp_on_innocents": f"{fp}/{n_innocent}" if n_innocent else "0/0",
        "fn_on_scams": f"{fn}/{n_scam}" if n_scam else "0/0",
    }


def print_table(report: dict[str, Any]) -> None:
    th = report["thresholds"]
    print(f"head: {report['head']}  scorer: {report['scorer_mode']}")
    print(f"thresholds: archive={th['archive']} block={th['block']} safe={th['safe']}")
    print()
    for corp in report["corpora"]:
        a = corp["archive_line"]
        print(f"=== {corp['name']} ({corp['n']} rows, {corp['path']}) ===")
        prec = "n/a" if a["precision"] is None else f"{a['precision']:.4f}"
        rec = "n/a" if a["recall"] is None else f"{a['recall']:.4f}"
        print(
            f"  archive line: FP {a['fp_on_innocents']}  FN {a['fn_on_scams']}  "
            f"precision={prec}  recall={rec}"
        )
        b = corp["block_line_score_only"]
        print(
            f"  block line (score only): FP {b['fp_on_innocents']}  FN {b['fn_on_scams']}"
        )
        print()
    comb = report.get("combined")
    if comb:
        a = comb["archive_line"]
        print(f"=== combined hk50 + data_v2 test ({comb['n']} rows) ===")
        prec = "n/a" if a["precision"] is None else f"{a['precision']:.4f}"
        rec = "n/a" if a["recall"] is None else f"{a['recall']:.4f}"
        print(
            f"  archive line: FP {a['fp_on_innocents']}  FN {a['fn_on_scams']}  "
            f"precision={prec}  recall={rec}"
        )
        print()


def main() -> None:
    parser = argparse.ArgumentParser(description="jevlike r1 eval on vendored JSONL corpora")
    parser.add_argument(
        "--corpus",
        action="append",
        metavar="NAME=PATH",
        help="Extra corpus (default: hk50 + data_v2 test under evals/)",
    )
    parser.add_argument(
        "--write-baseline",
        metavar="PATH",
        help="Write full JSON report (for evals/baselines/…)",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON report to stdout")
    args = parser.parse_args()

    corpora_spec: list[tuple[str, Path]] = list(DEFAULT_CORPORA)
    if args.corpus:
        corpora_spec = []
        for item in args.corpus:
            if "=" not in item:
                raise SystemExit(f"--corpus must be NAME=PATH, got {item!r}")
            name, rel = item.split("=", 1)
            corpora_spec.append((name.strip(), Path(rel).expanduser().resolve()))

    score_fn, mode = resolve_scorer()
    thresholds = load_thresholds()
    corpora_out: list[dict[str, Any]] = []
    for name, path in corpora_spec:
        if not path.is_file():
            raise SystemExit(f"missing corpus file: {path}")
        corpora_out.append(evaluate_corpus(name, path, score_fn))

    combined_n = sum(c["n"] for c in corpora_out)
    report: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "head": RELEASE_TAG,
        "scorer_mode": mode,
        "thresholds": thresholds,
        "corpora": corpora_out,
        "combined": {
            "n": combined_n,
            "archive_line": combined_metrics(corpora_out, "archive_line"),
            "block_line_score_only": combined_metrics(corpora_out, "block_line_score_only"),
        },
    }

    if args.write_baseline:
        out_path = Path(args.write_baseline).expanduser()
        if not out_path.is_absolute():
            out_path = ROOT / out_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[OK] wrote {out_path}", file=sys.stderr)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_table(report)


if __name__ == "__main__":
    main()
