#!/usr/bin/env python3
"""Mapping helpers for jevlike_serve.py (no torch / no encoder download)."""

import json
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

    def test_default_r1_only_no_legacy_fallback(self):
        """Missing r1 must error even when legacy heads exist under ROOT/models/."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            models_dir = root / "models"
            models_dir.mkdir()
            r1 = models_dir / "jevlike_hf_chinese_roberta_r1.pt"
            legacy_plain = models_dir / "jevlike_hf_chinese_roberta.pt"
            legacy_hn800 = models_dir / "hf_chinese_roberta_hn800.pt"
            legacy_plain.write_bytes(b"legacy-plain-stub")
            legacy_hn800.write_bytes(b"legacy-hn800-stub")

            self.assertFalse(r1.is_file())
            self.assertTrue(legacy_plain.is_file())
            self.assertTrue(legacy_hn800.is_file())
            # Pre-fix candidate walk (ROOT/models/*) would return the plain legacy head.
            self.assertEqual(
                next(
                    (
                        p
                        for p in (r1, legacy_plain, legacy_hn800)
                        if p.is_file()
                    ),
                    None,
                ),
                legacy_plain,
            )

            with patch.object(serve, "ROOT", root), patch.object(
                serve, "DEFAULT_CKPT", r1
            ):
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


class MaskSpanTests(unittest.TestCase):
    def test_masks_phone_name_and_otp_keeps_lure_words(self):
        text = "我係陳大文，電話 +852 6123 4567，驗證碼 123456"
        spans = serve.find_mask_spans(text)
        covered = []
        for span in spans:
            covered.append(text[span["start"] : span["end"]])
        self.assertIn("+852 6123 4567", covered)
        self.assertIn("陳大文", covered)
        self.assertIn("123456", covered)
        self.assertNotIn("驗證碼", "".join(covered))
        self.assertNotIn("我係", "".join(covered))

    def test_does_not_mask_org_or_role_or_year(self):
        for text in ("我係收數公司", "我係張經理", "如非本人操作", "今晚2026年見"):
            covered = "".join(
                text[span["start"] : span["end"]] for span in serve.find_mask_spans(text)
            )
            self.assertNotIn("收數", covered)
            self.assertNotIn("張經理", covered)
            self.assertNotIn("操作", covered)
            self.assertNotIn("2026", covered)

    def test_url_span_is_the_path_not_the_host(self):
        text = "睇 https://evil.example/secret?x=1"
        spans = [span for span in serve.find_mask_spans(text) if span["label"] == "url"]
        self.assertEqual(len(spans), 1)
        secret = text[spans[0]["start"] : spans[0]["end"]]
        self.assertIn("/secret", secret)
        self.assertNotIn("evil.example", secret)
        self.assertEqual(spans[0]["replacement"], " XXX")

    def test_payload_does_not_echo_source_text(self):
        text = "我係陳大文，電話 +852 6123 4567"
        payload = serve.mask_payload([text])
        raw = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("6123", raw)
        self.assertNotIn("陳大文", raw)
        self.assertNotIn(text, raw)
        self.assertEqual(payload["method"], "identifier_spans")

    def test_rejects_more_than_ten_messages(self):
        with self.assertRaises(ValueError):
            serve.mask_payload(["x"] * 11)


if __name__ == "__main__":
    unittest.main()
