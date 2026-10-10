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

    def test_option_index_and_unlabeled_fallback(self):
        self.assertEqual(serve.option_index(["not_scam", "scam"], "SCAM"), 1)
        self.assertIsNone(serve.option_index(["safe", "risk"], "scam"))
        self.assertAlmostEqual(
            serve.scam_probability(["safe", "risk"], [0.4, 0.6]),
            0.6,
        )

    def test_generate_split_spans_stay_inside_the_text(self):
        import pii_mask_data as data

        rows = data.generate_split("train", 4, 3)
        self.assertGreaterEqual(len(rows), 4)
        labelled = [row for row in rows if not row["hard_negative"]]
        self.assertTrue(labelled)
        for row in rows:
            for span in row["spans"]:
                self.assertGreater(span["end"], span["start"])
                self.assertLessEqual(span["end"], len(row["text"]))

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


class PiiMaskLabelTests(unittest.TestCase):
    def test_called_name_chinese_numeral_and_fullwidth_are_gold(self):
        import pii_mask_data as data

        called = data.gold_spans("我叫陳大文，方便打俾我嗎")
        self.assertIn("陳大文", _covered("我叫陳大文，方便打俾我嗎", called))
        numerals = "打去九一二三四五六七就可以"
        covered = _covered(numerals, data.gold_spans(numerals))
        self.assertIn("九一二三四五六七", covered)
        wide = "備用號碼９１２３４５６７留低"
        self.assertIn("９１２３４５６７", _covered(wide, data.gold_spans(wide)))

    def test_hard_negatives_have_no_gold_span(self):
        import pii_mask_data as data

        for text in data._HARD_NEGATIVES:
            self.assertEqual(data.gold_spans(text), [], text)

    def test_lure_words_are_cleared_from_model_flags(self):
        from pii_mask_head import clear_lure_chars, spans_from_flags

        text = "驗證碼 123456 請小心"
        flags = [True] * len(text)
        clear_lure_chars(text, flags)
        covered = _covered(text, spans_from_flags(text, flags))
        self.assertIn("123456", covered)
        self.assertNotIn("驗證碼", covered)
        self.assertNotIn("小心", covered)


def _covered(text, spans):
    return "".join(text[span["start"] : span["end"]] for span in spans)


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

    def test_payload_requires_the_mask_head(self):
        with self.assertRaises(RuntimeError):
            serve.mask_payload(["我係陳大文，電話 +852 6123 4567"])

    def test_rejects_more_than_ten_messages(self):
        with self.assertRaises(ValueError):
            serve.mask_payload(["x"] * 11)

    def test_mask_coverage_truncated_ignores_empty_offsets(self):
        self.assertFalse(serve.mask_coverage_truncated("", [(0, 0)]))
        self.assertFalse(serve.mask_coverage_truncated("甲" * 4, [(0, 0), (0, 4)]))
        self.assertTrue(serve.mask_coverage_truncated("甲" * 100 + "91234567", [(0, 1), (95, 96)]))
        self.assertTrue(isinstance(serve.MaskTruncated("mask truncated"), Exception))
        self.assertFalse(issubclass(serve.MaskTruncated, RuntimeError))

    def test_userinfo_idn_and_chinese_glued_identifiers(self):
        userinfo = "https://alice:s3cret!@evil.example/reset"
        self.assertEqual(
            _covered(userinfo, serve.find_mask_spans(userinfo)),
            "alice:s3cret!/reset",
        )
        idn = "https://例子.測試/secret-token"
        covered = _covered(idn, serve.find_mask_spans(idn))
        self.assertIn("secret-token", covered)
        self.assertNotIn("例子", covered)
        glued = "電郵user@example.com請回覆"
        self.assertIn("user@example.com", _covered(glued, serve.find_mask_spans(glued)))
        short = "請開wa.me/abc123secret"
        self.assertIn("abc123secret", _covered(short, serve.find_mask_spans(short)))

    def test_emoji_before_a_phone_uses_utf16_indexes(self):
        text = "😀91234567"
        spans = serve._to_utf16_spans(
            text, [{"start": 1, "end": 9, "label": "phone"}]
        )
        self.assertEqual(text[1:9], "91234567")
        self.assertEqual(spans, [{"start": 2, "end": 10, "label": "phone"}])


class LabelMetricTests(unittest.TestCase):
    def test_char_set_skips_spaces_and_prf_is_one_on_empty(self):
        import pii_mask_data as data

        covered = data.char_set("ab cd", [{"start": 0, "end": 5}])
        self.assertEqual(covered, {0, 1, 3, 4})
        perfect = data.prf(set(), set())
        self.assertEqual(perfect["f1"], 1.0)
        self.assertEqual(perfect["precision"], 1.0)
        self.assertEqual(perfect["recall"], 1.0)
        scored = data.prf({0, 1}, {1, 2})
        self.assertEqual(scored["tp"], 1)
        self.assertEqual(scored["fp"], 1)
        self.assertEqual(scored["fn"], 1)

    def test_authorized_requires_the_bearer_when_a_key_is_set(self):
        class Header:
            def __init__(self, value):
                self.value = value

            def get(self, _name, default=""):
                return self.value

        class Handler:
            def __init__(self, value):
                self.headers = Header(value)

        with patch.object(serve, "API_KEY", ""):
            self.assertTrue(serve.authorized(Handler("")))
        with patch.object(serve, "API_KEY", "secret"):
            self.assertTrue(serve.authorized(Handler("Bearer secret")))
            self.assertFalse(serve.authorized(Handler("Bearer other")))


class HeadStateTests(unittest.TestCase):
    def test_strips_encoder_and_head_prefix(self):
        from pii_mask_head import head_state_from_checkpoint

        state = head_state_from_checkpoint(
            {
                "encoder.weight": 1,
                "head.query.weight": 2,
                "context_norm.weight": 3,
                "other": 4,
            }
        )
        self.assertEqual(state, {"query.weight": 2, "context_norm.weight": 3})

    def test_empty_head_is_an_error(self):
        from pii_mask_head import head_state_from_checkpoint

        with self.assertRaises(ValueError):
            head_state_from_checkpoint({"encoder.weight": 1})


if __name__ == "__main__":
    unittest.main()
