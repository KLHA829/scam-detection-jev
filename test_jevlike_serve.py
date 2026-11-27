#!/usr/bin/env python3
"""Mapping helpers for jevlike_serve.py (no torch / no encoder download)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import jevlike_serve as serve


def tiny_mask_runtime(torch):
    class Tokenizer:
        option_calls = 0
        pad_token_id = 0

        def __call__(
            self,
            text,
            max_length=512,
            stride=0,
            return_overflowing_tokens=False,
            add_special_tokens=True,
            **kwargs,
        ):
            """One token per character, windowed like a Hugging Face fast tokenizer."""
            is_options = isinstance(text, list)
            self.option_calls += int(is_options)
            if is_options:
                rows = [[(ord(ch) % 97 + 1, [i, i + 1]) for i, ch in enumerate(row)] for row in text]
            else:
                chars = [(ord(ch) % 97 + 1, [i, i + 1]) for i, ch in enumerate(text) if not ch.isspace()]
                size = max_length - 2
                step = size - stride if return_overflowing_tokens else len(chars) + 1
                rows = [chars[start : start + size] for start in range(0, max(1, len(chars) - stride), step)]
            if add_special_tokens:
                rows = [[(3, [0, 0])] + row[: max_length - 2] + [(3, [0, 0])] for row in rows]
            width = max(map(len, rows))
            rows = [row + [(0, [0, 0])] * (width - len(row)) for row in rows]
            tokens = torch.tensor([[token for token, _ in row] for row in rows])
            result = {"input_ids": tokens, "attention_mask": (tokens != 0).long()}
            if not is_options:
                result["offset_mapping"] = torch.tensor([[span for _, span in row] for row in rows])
                result["overflow_to_sample_mapping"] = torch.zeros(len(rows), dtype=torch.long)
            return result

    class Encoder:
        calls = 0
        option_calls = 0

        def __init__(self):
            self.shapes = []

        def __call__(self, input_ids, attention_mask):
            self.calls += 1
            self.option_calls += int(input_ids.shape[0] == 2)
            self.shapes.append(tuple(input_ids.shape))
            hidden = torch.sin(input_ids.float().unsqueeze(-1) + torch.arange(64))
            return SimpleNamespace(last_hidden_state=hidden)

    class Head:
        rank = 64
        context_norm = staticmethod(lambda value: value)
        option_norm = staticmethod(lambda value: value)
        query = staticmethod(lambda value: value)
        key = staticmethod(lambda value: value)

    return {
        "_MODEL": SimpleNamespace(encoder=Encoder()),
        "_COLLATOR": SimpleNamespace(tokenizer=Tokenizer()),
        "_DEVICE": torch.device("cpu"),
        "_MASK_HEAD": Head(),
        "_MASK_CFG": {"context_tokens": 96},
        "_MASK_THRESHOLD": 0.5,
        "_MASK_OPTION_CACHE": None,
    }


class MaskOptionCacheTests(unittest.TestCase):
    def test_cached_and_uncached_rows_are_bit_identical(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        runtime = tiny_mask_runtime(torch)
        rows = ["電話91234567", "普通訊息", "😀 驗證碼123456", "", "abc@example.com"] * 2

        with patch.multiple(serve, **runtime):
            cached = serve.mask_payload(rows)
            self.assertEqual(runtime["_MODEL"].encoder.calls, 2)
            self.assertEqual(runtime["_MODEL"].encoder.option_calls, 1)
            self.assertEqual(runtime["_COLLATOR"].tokenizer.option_calls, 1)
            self.assertTrue(any(row["spans"] for row in cached["messages"]))
            uncached = []
            for row in rows:
                serve._MASK_OPTION_CACHE = None
                uncached.append({"spans": serve.model_mask_spans(row)})
            self.assertEqual(cached["messages"], uncached)
            self.assertEqual(serve.mask_payload([])["messages"], [])
            serve._MODEL = tiny_mask_runtime(torch)["_MODEL"]
            serve.model_mask_spans("new model")
            self.assertEqual(serve._MODEL.encoder.option_calls, 1)
            serve.model_mask_spans("next request")
            self.assertEqual(serve._MODEL.encoder.option_calls, 1)
            serve._MASK_CFG = {"mask_option": "custom mask"}
            serve.model_mask_spans("custom options")
            self.assertEqual(serve._MODEL.encoder.option_calls, 2)
            with patch.object(serve, "_MASK_HEAD", None):
                with self.assertRaises(RuntimeError):
                    serve.mask_payload(["private"])


class LongMessageMaskTests(unittest.TestCase):
    def setUp(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        self.runtime = tiny_mask_runtime(torch)

    def test_message_longer_than_context_is_masked_to_the_end(self):
        phone = "電話91234567"
        filler = "你" * 200
        with patch.multiple(serve, **self.runtime):
            expected = serve.model_mask_spans(phone)
            spans = serve.model_mask_spans(phone + filler + phone)
        self.assertTrue(expected)
        offset = len(phone) + len(filler)
        shifted = [{**span, "start": span["start"] + offset, "end": span["end"] + offset} for span in expected]
        self.assertEqual(spans, expected + shifted)
        self.assertEqual(self.runtime["_MODEL"].encoder.calls, 3)

    def test_trailing_characters_without_tokens_are_not_truncation(self):
        tokenizer = self.runtime["_COLLATOR"].tokenizer
        self.assertFalse(serve.mask_coverage_truncated("甲 \n", [(0, 1)], tokenizer))
        self.assertTrue(serve.mask_coverage_truncated("甲 9", [(0, 1)], tokenizer))
        with patch.multiple(serve, **self.runtime):
            self.assertEqual(serve.model_mask_spans("電話91234567  "), serve.model_mask_spans("電話91234567"))

    def test_tokenizer_that_drops_the_tail_still_fails_closed(self):
        tokenizer = self.runtime["_COLLATOR"].tokenizer

        class Truncating(type(tokenizer)):
            def __call__(self, text, max_length=512, **kwargs):
                kwargs.pop("return_overflowing_tokens", None)
                return super().__call__(text, max_length, **kwargs)

        with patch.multiple(serve, **self.runtime), patch.object(
            serve._COLLATOR, "tokenizer", Truncating()
        ):
            with self.assertRaises(serve.MaskTruncated):
                serve.model_mask_spans("x" * 100)


class BatchedMaskTests(unittest.TestCase):
    def setUp(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        self.torch = torch
        self.runtime = tiny_mask_runtime(torch)

    def test_mixed_lengths_empty_emoji_and_surrogates_keep_message_order(self):
        rows = [
            "電話91234567",
            "",
            "😀 驗證碼123456",
            "ab",
            "\ud800郵件abc@example.com",
            "你" * 110 + "電話91234567",
        ]
        with patch.multiple(serve, **self.runtime):
            batched = serve.mask_payload(rows)["messages"]
            individual = [{"spans": serve.model_mask_spans(row)} for row in rows]
            surrogate_free = serve.model_mask_spans("\ufffd郵件abc@example.com")
        self.assertEqual(batched, individual)
        self.assertEqual(batched[1]["spans"], [])
        self.assertEqual(batched[4]["spans"], surrogate_free)
        self.assertTrue(any(row["spans"] for row in batched))

    def test_total_windows_are_chunked_across_messages(self):
        rows = ["你" * 500, "電話91234567", "你" * 500]
        with patch.multiple(serve, **self.runtime):
            batched = serve.mask_payload(rows)["messages"]
            batch_calls = self.runtime["_MODEL"].encoder.calls
            shapes = list(self.runtime["_MODEL"].encoder.shapes)
            individual = [{"spans": serve.model_mask_spans(row)} for row in rows]
        self.assertEqual(batched, individual)
        self.assertEqual(batch_calls, 3)
        self.assertEqual([shape[0] for shape in shapes], [2, 16, 5])

    def test_message_too_long_fails_before_any_encoder_call(self):
        with patch.multiple(serve, **self.runtime), patch.object(serve, "_MAX_MASK_WINDOWS", 1):
            with self.assertRaisesRegex(ValueError, "message too long"):
                serve.mask_payload(["ok", "你" * 100])
        self.assertEqual(self.runtime["_MODEL"].encoder.calls, 0)

    def test_truncated_batch_fails_before_any_encoder_call(self):
        tokenizer = self.runtime["_COLLATOR"].tokenizer

        class Truncating(type(tokenizer)):
            def __call__(self, text, max_length=512, **kwargs):
                kwargs.pop("return_overflowing_tokens", None)
                return super().__call__(text, max_length, **kwargs)

        with patch.multiple(serve, **self.runtime), patch.object(
            serve._COLLATOR, "tokenizer", Truncating()
        ):
            with self.assertRaises(serve.MaskTruncated):
                serve.mask_payload(["ok", "x" * 100])
        self.assertEqual(self.runtime["_MODEL"].encoder.calls, 0)

    def test_empty_batch_runs_no_encoder_and_still_requires_the_head(self):
        with patch.multiple(serve, **self.runtime):
            self.assertEqual(serve.mask_payload([])["messages"], [])
            self.assertEqual(self.runtime["_MODEL"].encoder.calls, 0)
            self.assertEqual(self.runtime["_COLLATOR"].tokenizer.option_calls, 0)
            with patch.object(serve, "_MASK_HEAD", None):
                with self.assertRaises(RuntimeError):
                    serve.mask_payload([])
        self.assertEqual(self.runtime["_MODEL"].encoder.calls, 0)


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


class EnvDefaultTests(unittest.TestCase):
    def test_blank_bind_settings_stay_on_loopback(self):
        with patch.dict(
            os.environ,
            {"JEVLIKE_PORT": "", "JEVLIKE_HOST": "  ", "JEVLIKE_MAX_BODY": ""},
        ):
            self.assertEqual(serve.env_int("JEVLIKE_PORT", 8766), 8766)
            self.assertEqual(serve.env_str("JEVLIKE_HOST", "127.0.0.1"), "127.0.0.1")
            self.assertEqual(serve.env_int("JEVLIKE_MAX_BODY", 65536), 65536)
        with patch.dict(os.environ, {"JEVLIKE_PORT": "9001"}):
            self.assertEqual(serve.env_int("JEVLIKE_PORT", 8766), 9001)
        self.assertEqual(serve.env_int("JEVLIKE_PORT_UNSET_FOR_TEST", 8766), 8766)


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


class ThresholdTests(unittest.TestCase):
    def test_choose_threshold_keeps_a_hard_negative_clear(self):
        from pii_mask_head import choose_threshold, predict_spans

        text = "驗證碼 123456"
        spans = predict_spans(text, [(0, 3), (4, 10)], [0.99, 0.99], 0.5)
        covered = _covered(text, spans)
        self.assertIn("123456", covered)
        self.assertNotIn("驗證碼", covered)
        cache = {
            "rows": [
                {
                    "text": text,
                    "spans": [{"start": 4, "end": 10, "label": "otp"}],
                    "hard_negative": False,
                },
                {"text": "小心詐騙", "spans": [], "hard_negative": True},
            ],
            "offsets": [[(0, 3), (4, 10)], [(0, 4)]],
        }
        threshold, stats = choose_threshold(cache, [[0.2, 0.99], [0.01]])
        self.assertEqual(stats["hard_negative_rows_flagged"], 0)
        self.assertGreater(stats["f1"], 0)
        self.assertGreaterEqual(threshold, 0.2)
        self.assertLessEqual(threshold, 0.9)

    def test_choose_threshold_falls_back_when_every_cut_flags_the_negative(self):
        from pii_mask_head import choose_threshold

        cache = {
            "rows": [{"text": "普通一句", "spans": [], "hard_negative": True}],
            "offsets": [[(0, 4)]],
        }
        threshold, stats = choose_threshold(cache, [[0.99]])
        self.assertEqual(threshold, 0.9)
        self.assertGreater(stats["hard_negative_rows_flagged"], 0)


class UnloadedWorkerTests(unittest.TestCase):
    def test_mask_helpers_do_nothing_until_a_head_is_loaded(self):
        self.assertEqual(serve.model_mask_spans("電話91234567"), [])
        self.assertIsNone(serve.maybe_load_mask_head())
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.pt"
            with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(missing)}):
                with self.assertRaises(FileNotFoundError):
                    serve.resolve_mask_checkpoint()
            present = Path(tmp) / "mask.pt"
            present.write_bytes(b"stub")
            with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(present)}):
                self.assertEqual(serve.resolve_mask_checkpoint(), present)

    def test_http_routes_without_a_loaded_checkpoint(self):
        import threading
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError

        server = serve.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{port}/health") as res:
                body = json.loads(res.read().decode())
            self.assertEqual(res.status, 200)
            self.assertFalse(body["ok"])
            self.assertFalse(body["pii_mask"])

            mask = Request(
                f"http://127.0.0.1:{port}/v1/mask",
                data=json.dumps({"messages": ["電話91234567"]}).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(mask)
            self.assertEqual(ctx.exception.code, 503)

            bad = Request(
                f"http://127.0.0.1:{port}/v1/score",
                data=b"not-json",
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(bad)
            self.assertEqual(ctx.exception.code, 422)

            missing = Request(
                f"http://127.0.0.1:{port}/nope",
                data=b"{}",
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(missing)
            self.assertEqual(ctx.exception.code, 404)

            healthz = urlopen(f"http://127.0.0.1:{port}/healthz")
            self.assertEqual(healthz.status, 200)
            healthz.close()

            not_object = Request(
                f"http://127.0.0.1:{port}/v1/score",
                data=b"[]",
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(not_object)
            self.assertEqual(ctx.exception.code, 422)

            text_mask = Request(
                f"http://127.0.0.1:{port}/v1/mask",
                data=json.dumps({"text": "電話91234567"}).encode(),
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(text_mask)
            self.assertEqual(ctx.exception.code, 503)

            unloaded_score = Request(
                f"http://127.0.0.1:{port}/v1/score",
                data=json.dumps({"text": "你好"}).encode(),
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(unloaded_score)
            self.assertEqual(ctx.exception.code, 500)

            with patch.object(serve, "API_KEY", "secret"):
                denied = Request(
                    f"http://127.0.0.1:{port}/health",
                    method="POST",
                    data=b"{}",
                )
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(denied)
                self.assertEqual(ctx.exception.code, 401)

            import http.client

            conn = http.client.HTTPConnection("127.0.0.1", port)
            conn.request(
                "POST",
                "/v1/score",
                body=None,
                headers={"content-length": str(serve.MAX_BODY + 1)},
            )
            too_big = conn.getresponse()
            self.assertEqual(too_big.status, 413)
            too_big.read()
            conn.request(
                "POST",
                "/v1/score",
                body=b"not-a-json",
                headers={"content-length": "-1"},
            )
            negative = conn.getresponse()
            self.assertEqual(negative.status, 400)
            negative.read()
            conn.close()
        finally:
            server.shutdown()
            server.server_close()

    def test_maybe_load_does_nothing_without_a_checkpoint(self):
        saved = serve._MODEL
        serve._MODEL = object()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                missing = Path(tmp) / "missing.pt"
                with (
                    patch.object(serve, "DEFAULT_MASK_CKPT", missing),
                    patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": ""}, clear=False),
                ):
                    self.assertIsNone(serve.maybe_load_mask_head())
        finally:
            serve._MODEL = saved


def _install_jevlike_stub():
    import sys
    import types

    if "jevlike" in sys.modules and hasattr(sys.modules["jevlike"], "data"):
        return
    jevlike = types.ModuleType("jevlike")
    model = types.ModuleType("jevlike.model")
    data = types.ModuleType("jevlike.data")
    train = types.ModuleType("jevlike.train")

    class AttentionHead:
        def __init__(self, *args, **kwargs):
            pass

    class ChoiceExample:
        def __init__(self, text, labels, label_index=0):
            self.text = text
            self.labels = labels
            self.label_index = label_index

    def move(batch, device):
        return batch

    model.AttentionHead = AttentionHead
    model.make_system = lambda config, device: (None, None)
    data.ChoiceExample = ChoiceExample
    train.move = move
    jevlike.model = model
    jevlike.data = data
    jevlike.train = train
    sys.modules["jevlike"] = jevlike
    sys.modules["jevlike.model"] = model
    sys.modules["jevlike.data"] = data
    sys.modules["jevlike.train"] = train


class TorchHelperTests(unittest.TestCase):
    def setUp(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        self.torch = torch
        _install_jevlike_stub()

    def test_pool_and_mask_logits_and_training_steps(self):
        import importlib.util

        from pii_mask_head import mask_option_logits, pool_token_hidden

        torch = self.torch
        hidden = torch.ones(2, 3, 4)
        mask = torch.tensor([[True, True, False], [True, False, False]])
        pooled = pool_token_hidden(hidden, mask)
        self.assertEqual(tuple(pooled.shape), (2, 4))
        self.assertTrue(torch.allclose(pooled[0], torch.ones(4)))

        class Head:
            rank = 4

            def context_norm(self, value):
                return value

            def option_norm(self, value):
                return value

            def query(self, value):
                return value[..., : self.rank]

            def key(self, value):
                return value[..., : self.rank]

        logits = mask_option_logits(Head(), hidden, torch.ones(2, 4))
        self.assertEqual(tuple(logits.shape), (2, 3))

        spec = importlib.util.spec_from_file_location(
            "train_pii_mask_under_test",
            Path(__file__).resolve().parent / "scripts" / "train_pii_mask.py",
        )
        train = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(train)

        loss = train.loss_on(
            torch.zeros(2),
            torch.tensor([0.0, 1.0]),
            torch.tensor([False, False]),
            torch.tensor([True, True]),
            torch.tensor(1.0),
        )
        self.assertEqual(loss.ndim, 0)
        empty = train.loss_on(
            torch.ones(2),
            torch.ones(2),
            torch.tensor([True, True]),
            torch.tensor([True, True]),
            torch.tensor(1.0),
        )
        self.assertEqual(float(empty), 0.0)

        batched = train.batched_logits(Head(), hidden, torch.ones(2, 4), mask, 1)
        self.assertEqual(tuple(batched.shape), (2, 3))

        class Tokenizer:
            def __call__(self, texts, **kwargs):
                count = len(texts)
                return {
                    "input_ids": torch.ones(count, 3, dtype=torch.long),
                    "attention_mask": torch.ones(count, 3, dtype=torch.long),
                    "offset_mapping": torch.tensor([[[0, 0], [0, 1], [1, 2]]] * count),
                }

        class Encoder:
            def eval(self):
                return self

            def __call__(self, input_ids, attention_mask):
                batch, length = input_ids.shape
                return type(
                    "Out",
                    (),
                    {"last_hidden_state": torch.ones(batch, length, 4)},
                )()

        rows = [{"text": "ab", "spans": [{"start": 1, "end": 2}]}]
        cached = train.cache_split(rows, Tokenizer(), Encoder(), torch.device("cpu"), 8)
        self.assertEqual(tuple(cached["hidden"].shape), (1, 3, 4))
        self.assertEqual(float(cached["labels"][0, 2]), 1.0)
        self.assertTrue(bool(cached["special"][0, 0]))
        options = train.encode_options(Tokenizer(), Encoder(), torch.device("cpu"))
        self.assertEqual(tuple(options.shape), (2, 4))

        with self.assertRaises(SystemExit):
            old = sys.argv
            sys.argv = [
                "train_pii_mask.py",
                "--output",
                str(train.R1_PATH),
            ]
            try:
                train.main()
            finally:
                sys.argv = old

    def test_score_text_and_truncated_mask_with_fakes(self):
        torch = self.torch
        saved = {
            "model": serve._MODEL,
            "collator": serve._COLLATOR,
            "device": serve._DEVICE,
            "options": serve._OPTIONS,
            "encoder": serve._ENCODER_ID,
            "ckpt": serve._CHECKPOINT_PATH,
            "head": serve._MASK_HEAD,
            "cfg": serve._MASK_CFG,
            "config": serve._CONFIG,
            "mask_option_cache": serve._MASK_OPTION_CACHE,
        }

        class Collator:
            def __call__(self, examples):
                return {"examples": examples}

            tokenizer = None

        class Model:
            def __call__(self, batch):
                return torch.tensor([[0.1, 2.0]])

        try:
            serve._MODEL = Model()
            serve._COLLATOR = Collator()
            serve._DEVICE = torch.device("cpu")
            serve._OPTIONS = ("not_scam", "scam")
            serve._ENCODER_ID = "stub"
            serve._CHECKPOINT_PATH = None
            scored = serve.score_text("你好")
            self.assertEqual(scored["label"], "scam")
            self.assertGreater(scored["prob_scam"], 0.5)
            import threading
            from urllib.request import Request, urlopen

            server = serve.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                req = Request(
                    f"http://127.0.0.1:{port}/v1/score",
                    data=json.dumps({"text": "你好", "options": ["not_scam", "scam"]}).encode(),
                    method="POST",
                )
                with urlopen(req) as res:
                    body = json.loads(res.read().decode())
                self.assertEqual(res.status, 200)
                self.assertEqual(body["label"], "scam")
            finally:
                server.shutdown()
                server.server_close()
            with self.assertRaises(ValueError):
                serve.score_text("   ")
            with self.assertRaises(ValueError):
                serve.score_text("你好", ("only-one",))

            class Tok:
                def __call__(self, text, **kwargs):
                    length = len(text)
                    return {
                        "input_ids": torch.ones(1, 2, dtype=torch.long),
                        "attention_mask": torch.ones(1, 2, dtype=torch.long),
                        "offset_mapping": torch.tensor([[[0, 0], [0, length]]]),
                    }

            class Enc:
                def __call__(self, input_ids, attention_mask):
                    batch, length = input_ids.shape[0], input_ids.shape[1]
                    return type(
                        "Out",
                        (),
                        {"last_hidden_state": torch.ones(batch, length, 4)},
                    )()

                encoder = property(lambda self: self)

            class Head:
                rank = 4

                def context_norm(self, value):
                    return value

                def option_norm(self, value):
                    return value

                def query(self, value):
                    return value[..., : self.rank]

                def key(self, value):
                    return value[..., : self.rank]

            serve._MASK_HEAD = Head()
            serve._MODEL = Enc()
            serve._COLLATOR = type("C", (), {"tokenizer": Tok()})()
            serve._MASK_CFG = {"context_tokens": 8, "mask_threshold": 0.5}
            spans = serve.model_mask_spans("ab")
            self.assertIsInstance(spans, list)

            class ShortTok(Tok):
                def __call__(self, text, **kwargs):
                    return {
                        "input_ids": torch.ones(1, 2, dtype=torch.long),
                        "attention_mask": torch.ones(1, 2, dtype=torch.long),
                        "offset_mapping": torch.tensor([[[0, 0], [0, 1]]]),
                    }

            serve._COLLATOR = type("C", (), {"tokenizer": ShortTok()})()
            with self.assertRaises(serve.MaskTruncated):
                serve.model_mask_spans("abcd")
        finally:
            serve._MODEL = saved["model"]
            serve._COLLATOR = saved["collator"]
            serve._DEVICE = saved["device"]
            serve._OPTIONS = saved["options"]
            serve._ENCODER_ID = saved["encoder"]
            serve._CHECKPOINT_PATH = saved["ckpt"]
            serve._MASK_HEAD = saved["head"]
            serve._MASK_CFG = saved["cfg"]
            serve._CONFIG = saved["config"]
            serve._MASK_OPTION_CACHE = saved["mask_option_cache"]

    def test_load_runtime_rejects_a_checkpoint_that_is_not_a_head(self):
        torch = self.torch
        saved = {
            "options": serve._OPTIONS,
            "ckpt": serve._CHECKPOINT_PATH,
            "config": serve._CONFIG,
            "encoder": serve._ENCODER_ID,
            "device": serve._DEVICE,
            "model": serve._MODEL,
            "collator": serve._COLLATOR,
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "not-a-head.pt"
            torch.save({"nope": 1}, path)
            with patch.dict(os.environ, {"JEVLIKE_CKPT": str(path)}):
                with self.assertRaises(ValueError):
                    serve.load_runtime()
        serve._OPTIONS = saved["options"]
        serve._CHECKPOINT_PATH = saved["ckpt"]
        serve._CONFIG = saved["config"]
        serve._ENCODER_ID = saved["encoder"]
        serve._DEVICE = saved["device"]
        serve._MODEL = saved["model"]
        serve._COLLATOR = saved["collator"]
        serve._MASK_HEAD = None
        serve._MASK_CFG = None
        serve._MASK_PATH = None


class SyntheticLabelTests(unittest.TestCase):
    def test_fullwidth_digits_stay_off_the_shared_stub_and_on_the_gold(self):
        import pii_mask_data as data

        text = "全形４５６７８９０１"
        self.assertEqual(serve.find_mask_spans(text), [])
        gold = data.gold_spans(text)
        self.assertEqual(gold, [{"start": 2, "end": 10, "label": "phone"}])
        spoken = "電話一二三四五六七八"
        self.assertEqual(serve.find_mask_spans(spoken), [])
        self.assertEqual(data.extra_gold_spans(spoken)[0]["label"], "phone")

    def test_generate_split_labels_positives_and_keeps_hard_negatives_clear(self):
        import pii_mask_data as data

        train = data.generate_split("train", 12, 3)
        val = data.generate_split("val", 12, 3)
        self.assertEqual(len(train), 17)
        self.assertEqual(len(val), 17)
        for row in train + val:
            if row["hard_negative"]:
                self.assertEqual(row["spans"], [])
            else:
                self.assertTrue(row["spans"])


class MaskHeadLoadTests(unittest.TestCase):
    def setUp(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not installed")
        self.torch = torch
        _install_jevlike_stub()

    def test_rejects_the_wrong_task_and_loads_a_pii_head(self):
        torch = self.torch
        saved = {
            "model": serve._MODEL,
            "device": serve._DEVICE,
            "head": serve._MASK_HEAD,
            "cfg": serve._MASK_CFG,
            "path": serve._MASK_PATH,
            "threshold": serve._MASK_THRESHOLD,
        }

        class Head:
            def __init__(self, hidden, rank):
                self.hidden = hidden
                self.rank = rank

            def load_state_dict(self, state, strict=True):
                if strict and "query.weight" not in state:
                    raise RuntimeError("missing query")
                self.state = state

            def to(self, _device):
                return self

            def eval(self):
                return self

        sys.modules["jevlike.model"].AttentionHead = Head
        serve._MODEL = type(
            "Model",
            (),
            {"encoder": type("Enc", (), {"config": type("Cfg", (), {"hidden_size": 8})()})()},
        )()
        serve._DEVICE = torch.device("cpu")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wrong = Path(tmp) / "wrong.pt"
                torch.save({"config": {"task": "scam"}, "state_dict": {}}, wrong)
                with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(wrong)}):
                    with self.assertRaises(ValueError):
                        serve.maybe_load_mask_head()
                good = Path(tmp) / "pii.pt"
                torch.save(
                    {
                        "config": {
                            "task": "pii_mask",
                            "rank": 4,
                            "mask_threshold": 0.42,
                            "context_tokens": 12,
                        },
                        "state_dict": {"head.query.weight": 1},
                    },
                    good,
                )
                with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(good)}):
                    serve.maybe_load_mask_head()
                self.assertEqual(serve._MASK_THRESHOLD, 0.42)
                self.assertEqual(serve._MASK_HEAD.state, {"query.weight": 1})
                with self.assertRaises(ValueError):
                    serve.mask_payload(["ok", 1])
        finally:
            serve._MODEL = saved["model"]
            serve._DEVICE = saved["device"]
            serve._MASK_HEAD = saved["head"]
            serve._MASK_CFG = saved["cfg"]
            serve._MASK_PATH = saved["path"]
            serve._MASK_THRESHOLD = saved["threshold"]

    def test_main_stops_before_listen_when_the_checkpoint_is_not_a_head(self):
        torch = self.torch
        saved = {
            "options": serve._OPTIONS,
            "ckpt": serve._CHECKPOINT_PATH,
            "config": serve._CONFIG,
            "encoder": serve._ENCODER_ID,
            "device": serve._DEVICE,
            "model": serve._MODEL,
            "collator": serve._COLLATOR,
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "not-a-head.pt"
            torch.save({"nope": 1}, path)
            with patch.dict(os.environ, {"JEVLIKE_CKPT": str(path)}):
                with self.assertRaises(ValueError):
                    serve.main()
        serve._OPTIONS = saved["options"]
        serve._CHECKPOINT_PATH = saved["ckpt"]
        serve._CONFIG = saved["config"]
        serve._ENCODER_ID = saved["encoder"]
        serve._DEVICE = saved["device"]
        serve._MODEL = saved["model"]
        serve._COLLATOR = saved["collator"]


class RegressionFixTests(unittest.TestCase):
    def test_clear_lure_chars_clears_advice_but_keeps_names_emails_and_urls(self):
        try:
            import pii_mask_head as mh
        except ImportError as exc:
            self.skipTest(f"pii_mask_head unavailable: {exc}")

        cases = [
            ("驗證碼 123456 請小心", [True] * 14, ("小心", False), ("123456", True)),
            ("我叫陳小心，電話 91234567", [False, False, True, True, True] + [False] * 12, ("小心", True), None),
            ("電郵 小心88@example.com", [False, False, False] + [True] * 17, ("小心", True), None),
            ("https://evil.example/密碼重設", [False] * 20 + [True] * 5, ("密碼", True), None),
        ]
        for text, flags, (needle, want), digit_expect in cases:
            out = mh.clear_lure_chars(text, list(flags))
            pos = text.index(needle)
            self.assertEqual(any(out[pos : pos + len(needle)]), want, text)
            if digit_expect is not None:
                d_needle, d_want = digit_expect
                d_pos = text.index(d_needle)
                self.assertEqual(all(out[d_pos : d_pos + len(d_needle)]), d_want, text)

    def test_flags_from_window_offsets_unions_overlapping_windows(self):
        try:
            import pii_mask_head as mh
        except ImportError as exc:
            self.skipTest(f"pii_mask_head unavailable: {exc}")

        text = "abcd"
        # Window 0 flags 'd' (0.7 >= 0.5) while Window 1 scores 'd' below threshold (0.1 < 0.5);
        # unioning overlapping windows preserves the positive redaction.
        flags = mh.flags_from_window_offsets(
            text,
            window_offsets=[[(0, 1), (1, 2), (2, 3), (3, 4)], [(2, 3), (3, 4), (0, 0), (0, 0)]],
            window_probs=[[0.9, 0.9, 0.1, 0.7], [0.1, 0.1, 0.0, 0.0]],
            threshold=0.5,
        )
        self.assertEqual(flags, [True, True, False, True])

    def test_mask_coverage_truncated_catches_interior_gaps_and_allows_trailing_space(self):
        def tok(s, **_kw):
            return {"input_ids": SimpleNamespace(numel=lambda: len(s.strip()))}

        self.assertTrue(serve.mask_coverage_truncated("a" * 30, [(0, 5), (25, 30)], tokenizer=tok))
        self.assertFalse(serve.mask_coverage_truncated("hello   ", [(0, 5)], tokenizer=tok))

    def test_lone_surrogate_and_url_email_heuristics(self):
        surrogate_text = "a\ud83d91234567"
        spans = serve.find_mask_spans(surrogate_text)
        self.assertTrue(all(isinstance(s["start"], int) and s["start"] >= 0 for s in spans))
        utf16 = serve._to_utf16_spans(surrogate_text, [{"start": 2, "end": 10, "label": "phone"}])
        self.assertEqual(utf16, [{"start": 2, "end": 10, "label": "phone"}])

        userinfo = "https://alice:evil.com@evil.com/path"
        self.assertEqual(_covered(userinfo, serve._url_spans(userinfo)), "alice:evil.com/path")

        dotted_i = "https://İ.example/secret"
        dotted_covered = _covered(dotted_i, serve.find_mask_spans(dotted_i))
        self.assertIn("secret", dotted_covered)

        glued_short = "bit.ly/abc立即轉帳"
        self.assertEqual(_covered(glued_short, serve.find_mask_spans(glued_short)), "abc")

        fps_url = "fps: https://evil.example/pay"
        fps_spans = serve.find_mask_spans(fps_url)
        self.assertTrue(any(s["label"] == "url" for s in fps_spans))
        self.assertFalse(any(s["label"] == "payment_handle" and "https" in fps_url[s["start"]:s["end"]] for s in fps_spans))

        spaced_fps = "轉數快 1234 5678"
        self.assertEqual(_covered(spaced_fps, serve.find_mask_spans(spaced_fps)), "1234 5678")

    def test_pii_mask_data_includes_rare_surnames_and_urls(self):
        import pii_mask_data as data

        self.assertIn("歐", data._TRAIN_SURNAMES)
        self.assertIn("司", data._TEST_SURNAMES)
        samples = data.generate_split("train", 200, seed=7)
        joined = "\n".join(row["text"] for row in samples)
        self.assertIn("http", joined)

    def test_http_rejects_invalid_utf8_and_chunked_encoding(self):
        import http.client
        from http.server import ThreadingHTTPServer
        import threading

        server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        try:
            with patch.object(serve, "API_KEY", ""):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                bad_utf8 = b'{"messages":["\xff\xfe"]}'
                conn.request("POST", "/v1/mask", body=bad_utf8, headers={"Content-Type": "application/json"})
                res1 = conn.getresponse()
                res1.read()
                self.assertEqual(res1.status, 422)
                conn.close()

                conn2 = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                conn2.putrequest("POST", "/v1/mask")
                conn2.putheader("Transfer-Encoding", "chunked")
                conn2.endheaders(b"0\r\n\r\n")
                res2 = conn2.getresponse()
                res2.read()
                self.assertEqual(res2.status, 411)
                conn2.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
