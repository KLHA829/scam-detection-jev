#!/usr/bin/env python3
"""Mapping helpers for jevlike_serve.py (no torch / no encoder download)."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import jevlike_serve as serve


class ScamProbabilityTests(unittest.TestCase):
    def test_named_scam_option(self):
        self.assertAlmostEqual(
            serve.scam_probability(["not_scam", "scam"], [0.2, 0.8]),
            0.8,
        )
        self.assertAlmostEqual(
            serve.scam_probability(["scam", "not_scam"], [0.9, 0.1]),
            0.9,
        )

    def test_case_insensitive(self):
        self.assertAlmostEqual(
            serve.scam_probability(["Not_Scam", "SCAM"], [0.3, 0.7]),
            0.7,
        )

    def test_falls_back_to_last_when_unlabeled(self):
        self.assertAlmostEqual(
            serve.scam_probability(["safe", "risk"], [0.4, 0.6]),
            0.6,
        )

    def test_parse_options_default(self):
        self.assertEqual(serve.parse_options(None), ("not_scam", "scam"))
        self.assertEqual(serve.parse_options(" not_scam, scam "), ("not_scam", "scam"))

    def test_published_release_download_url(self):
        self.assertEqual(serve.RELEASE_TAG, "jevlike-hf-r1")
        self.assertEqual(serve.RELEASE_ASSET, "jevlike_hf_chinese_roberta_r1.pt")
        self.assertEqual(
            serve.RELEASE_DOWNLOAD_URL,
            "https://github.com/KLHA829/scam-detection-jev/releases/download/"
            "jevlike-hf-r1/jevlike_hf_chinese_roberta_r1.pt",
        )


class ResolveCheckpointTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "JEVLIKE_CKPT": os.environ.pop("JEVLIKE_CKPT", None),
            "JEVLIKE_CHECKPOINT": os.environ.pop("JEVLIKE_CHECKPOINT", None),
        }

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_explicit_env_uses_path(self):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            path = Path(handle.name)
        try:
            os.environ["JEVLIKE_CKPT"] = str(path)
            self.assertEqual(serve.resolve_checkpoint(), path)
        finally:
            path.unlink(missing_ok=True)

    def test_explicit_env_missing_fails(self):
        os.environ["JEVLIKE_CKPT"] = "/tmp/jevlike-missing-test.ckpt"
        with self.assertRaises(FileNotFoundError) as ctx:
            serve.resolve_checkpoint()
        self.assertIn("JEVLIKE_CKPT not found", str(ctx.exception))

    def test_default_r1_only_no_hn800_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            r1 = root / "jevlike_hf_chinese_roberta_r1.pt"
            hn800 = root / "hf_chinese_roberta_hn800.pt"
            hn800.write_bytes(b"not-a-real-checkpoint")
            with patch.object(serve, "DEFAULT_CKPT", r1):
                with self.assertRaises(FileNotFoundError) as ctx:
                    serve.resolve_checkpoint()
                msg = str(ctx.exception)
                self.assertIn("r1 checkpoint not found", msg)
                self.assertIn(str(r1), msg)

    def test_default_loads_r1_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            r1 = Path(tmp) / "jevlike_hf_chinese_roberta_r1.pt"
            r1.write_bytes(b"stub")
            with patch.object(serve, "DEFAULT_CKPT", r1):
                self.assertEqual(serve.resolve_checkpoint(), r1)


if __name__ == "__main__":
    unittest.main()
