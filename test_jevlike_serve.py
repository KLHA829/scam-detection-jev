#!/usr/bin/env python3
"""Mapping helpers for jevlike_serve.py (no torch / no encoder download)."""

import json
import os
import random
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
            self.seen_inputs = []

        def __call__(self, input_ids, attention_mask):
            self.calls += 1
            self.option_calls += int(input_ids.shape[0] == 2)
            self.shapes.append(tuple(input_ids.shape))
            self.seen_inputs.append((input_ids.detach().clone(), attention_mask.detach().clone()))
            hidden = torch.sin(input_ids.float().unsqueeze(-1) + torch.arange(64))
            return SimpleNamespace(last_hidden_state=hidden)

    class Head:
        rank = 64
        context_norm = staticmethod(lambda value: value)
        option_norm = staticmethod(lambda value: value)
        query = staticmethod(lambda value: value)
        key = staticmethod(lambda value: value)

    return {
        "_ENCODER": Encoder(),
        "_TOKENIZER": Tokenizer(),
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
        import pii_mask_head

        runtime = tiny_mask_runtime(torch)
        rows = ["電話91234567", "普通訊息", "😀 驗證碼123456", "", "abc@example.com"] * 2
        logits = []
        original = pii_mask_head.mask_option_logits

        def record(*args):
            result = original(*args)
            logits.append(result.clone())
            return result

        with patch.multiple(serve, **runtime), patch.object(
            pii_mask_head, "mask_option_logits", side_effect=record
        ):
            uncached_batch = serve.mask_payload(rows)
            chunks_per_batch = len(logits)
            self.assertEqual(runtime["_ENCODER"].calls, 1 + chunks_per_batch)
            self.assertEqual(runtime["_ENCODER"].option_calls, 1)
            self.assertEqual(runtime["_TOKENIZER"].option_calls, 1)
            self.assertTrue(any(row["spans"] for row in uncached_batch["messages"]))
            cached_batch = serve.mask_payload(rows)
            self.assertEqual(runtime["_ENCODER"].calls, 1 + 2 * chunks_per_batch)
            self.assertEqual(runtime["_ENCODER"].option_calls, 1)
            self.assertEqual(runtime["_TOKENIZER"].option_calls, 1)
            self.assertEqual(cached_batch, uncached_batch)
            self.assertEqual(len(logits), 2 * chunks_per_batch)
            for before, after in zip(logits[:chunks_per_batch], logits[chunks_per_batch:]):
                self.assertTrue(torch.equal(before, after))
            uncached = []
            for row in rows:
                serve._MASK_OPTION_CACHE = None
                uncached.append({"spans": serve.model_mask_spans(row)})
            self.assertEqual(cached_batch["messages"], uncached)
            self.assertEqual(serve.mask_payload([])["messages"], [])
            serve._ENCODER = tiny_mask_runtime(torch)["_ENCODER"]
            serve.model_mask_spans("new model")
            self.assertEqual(serve._ENCODER.option_calls, 1)
            serve.model_mask_spans("next request")
            self.assertEqual(serve._ENCODER.option_calls, 1)
            serve._MASK_CFG = {"mask_option": "custom mask"}
            serve.model_mask_spans("custom options")
            self.assertEqual(serve._ENCODER.option_calls, 2)
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
        self.assertEqual(self.runtime["_ENCODER"].calls, 3)

    def test_trailing_characters_without_tokens_are_not_truncation(self):
        tokenizer = self.runtime["_TOKENIZER"]
        self.assertFalse(serve.mask_coverage_truncated("甲 \n", [(0, 1)], tokenizer))
        self.assertTrue(serve.mask_coverage_truncated("甲 9", [(0, 1)], tokenizer))
        with patch.multiple(serve, **self.runtime):
            self.assertEqual(serve.model_mask_spans("電話91234567  "), serve.model_mask_spans("電話91234567"))

    def test_tokenizer_that_drops_the_tail_still_fails_closed(self):
        tokenizer = self.runtime["_TOKENIZER"]

        class Truncating(type(tokenizer)):
            def __call__(self, text, max_length=512, **kwargs):
                kwargs.pop("return_overflowing_tokens", None)
                return super().__call__(text, max_length, **kwargs)

        with patch.multiple(serve, **self.runtime), patch.object(
            serve, "_TOKENIZER", Truncating()
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
            batch_calls = self.runtime["_ENCODER"].calls
            shapes = list(self.runtime["_ENCODER"].shapes)
            individual = [{"spans": serve.model_mask_spans(row)} for row in rows]
        self.assertEqual(batched, individual)
        self.assertEqual(batch_calls, 3)
        context_shapes = shapes[1:]
        self.assertEqual(sum(shape[0] for shape in context_shapes), 21)
        self.assertTrue(all(1 <= shape[0] <= serve._MASK_WINDOW_BATCH for shape in context_shapes))

    def test_mixed_length_batch_bounds_padding_work_and_prevents_padding_leakage(self):
        torch = self.torch
        tokenizer = self.runtime["_TOKENIZER"]
        tokenizer.pad_token_id = 200

        class AttentionAwareEncoder:
            def __init__(self):
                self.calls = 0
                self.shapes = []
                self.seen_inputs = []

            def __call__(self, input_ids, attention_mask):
                self.calls += 1
                self.shapes.append(tuple(input_ids.shape))
                self.seen_inputs.append((input_ids.detach().clone(), attention_mask.detach().clone()))
                base = torch.sin(input_ids.float().unsqueeze(-1) + torch.arange(64))
                # Any non-zero attention on padding tokens would shift row_mean and perturb real tokens.
                mask = attention_mask.unsqueeze(-1).float()
                row_mean = (base * mask).sum(dim=1, keepdim=True) / mask.sum(dim=1, keepdim=True).clamp_min(1.0)
                return SimpleNamespace(last_hidden_state=base + 0.1 * row_mean)

        encoder = AttentionAwareEncoder()
        self.runtime["_ENCODER"] = encoder

        rows = ["電話91234567"] * 9 + ["你" * 94]
        with patch.multiple(serve, **self.runtime):
            batched = serve.mask_payload(rows)["messages"]
            context_shapes = list(encoder.shapes[1:])
            context_inputs = list(encoder.seen_inputs[1:])
            individual = [{"spans": serve.model_mask_spans(row)} for row in rows]

        self.assertEqual(batched, individual)
        self.assertEqual(context_shapes, [(9, 12), (1, 96)])
        total_positions = sum(r * c for r, c in context_shapes)
        self.assertLess(total_positions, 250)
        for batch_ids, batch_mask in context_inputs:
            self.assertTrue(torch.all(batch_ids[batch_mask == 0] == tokenizer.pad_token_id))
            self.assertTrue(torch.all(batch_mask[batch_ids != tokenizer.pad_token_id] == 1))

    def test_attention_mask_zeros_all_padded_positions_in_mixed_width_chunks(self):
        torch = self.torch
        rows = ["ab", "電話91234567", "abc@example.com"]
        with patch.multiple(serve, **self.runtime):
            batched = serve.mask_payload(rows)["messages"]
            context_inputs = list(self.runtime["_ENCODER"].seen_inputs[1:])
            individual = [{"spans": serve.model_mask_spans(row)} for row in rows]
        self.assertEqual(batched, individual)
        for batch_ids, batch_mask in context_inputs:
            self.assertTrue(torch.all(batch_ids[batch_mask == 0] == 0))
            self.assertTrue(torch.all(batch_mask[batch_ids != 0] == 1))

    def test_message_too_long_fails_before_any_encoder_call(self):
        with patch.multiple(serve, **self.runtime), patch.object(serve, "_MAX_MASK_WINDOWS", 1):
            with self.assertRaisesRegex(ValueError, "message too long"):
                serve.mask_payload(["ok", "你" * 100])
        self.assertEqual(self.runtime["_ENCODER"].calls, 0)

    def test_truncated_batch_fails_before_any_encoder_call(self):
        tokenizer = self.runtime["_TOKENIZER"]

        class Truncating(type(tokenizer)):
            def __call__(self, text, max_length=512, **kwargs):
                kwargs.pop("return_overflowing_tokens", None)
                return super().__call__(text, max_length, **kwargs)

        with patch.multiple(serve, **self.runtime), patch.object(
            serve, "_TOKENIZER", Truncating()
        ):
            with self.assertRaises(serve.MaskTruncated):
                serve.mask_payload(["ok", "x" * 100])
        self.assertEqual(self.runtime["_ENCODER"].calls, 0)

    def test_empty_batch_runs_no_encoder_and_still_requires_the_head(self):
        with patch.multiple(serve, **self.runtime):
            self.assertEqual(serve.mask_payload([])["messages"], [])
            self.assertEqual(self.runtime["_ENCODER"].calls, 0)
            self.assertEqual(self.runtime["_TOKENIZER"].option_calls, 0)
            with patch.object(serve, "_MASK_HEAD", None):
                with self.assertRaises(RuntimeError):
                    serve.mask_payload([])
        self.assertEqual(self.runtime["_ENCODER"].calls, 0)


class PiiMaskDataSplitTests(unittest.TestCase):
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


class ResolveMaskCheckpointTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "JEVLIKE_MASK_CKPT": os.environ.pop("JEVLIKE_MASK_CKPT", None),
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
            os.environ["JEVLIKE_MASK_CKPT"] = str(path)
            self.assertEqual(serve.resolve_mask_checkpoint(), path)
        finally:
            path.unlink(missing_ok=True)

    def test_explicit_env_missing_fails(self):
        os.environ["JEVLIKE_MASK_CKPT"] = "/tmp/jevlike-mask-missing-test.pt"
        with self.assertRaises(FileNotFoundError) as ctx:
            serve.resolve_mask_checkpoint()
        self.assertIn("JEVLIKE_MASK_CKPT not found", str(ctx.exception))

    def test_default_missing_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "jevlike_hf_pii_mask.pt"
            with patch.object(serve, "DEFAULT_MASK_CKPT", missing):
                with self.assertRaises(FileNotFoundError) as ctx:
                    serve.resolve_mask_checkpoint()
                msg = str(ctx.exception)
                self.assertIn("PII mask checkpoint not found", msg)
                self.assertIn(str(missing), msg)

    def test_default_loads_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            mask_ckpt = Path(tmp) / "jevlike_hf_pii_mask.pt"
            mask_ckpt.write_bytes(b"stub")
            with patch.object(serve, "DEFAULT_MASK_CKPT", mask_ckpt):
                self.assertEqual(serve.resolve_mask_checkpoint(), mask_ckpt)


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

    def test_generated_hard_negatives_include_digits_without_gold_spans(self):
        import pii_mask_data as data

        rng = random.Random(7)
        saw_order = False
        for frame in data._HARD_NEGATIVE_FRAMES:
            for _ in range(4):
                text = data._negative_fill(rng, frame)
                saw_order = saw_order or "訂單編號" in text
                self.assertEqual(data.gold_spans(text), [], text)
        rows = data.generate_split("train", 30, 17)
        negatives = [row for row in rows if row["hard_negative"]]
        self.assertGreaterEqual(len(negatives), 15)
        self.assertTrue(saw_order)
        self.assertTrue(all(not row["spans"] for row in negatives))

    def test_order_reference_digits_are_not_training_otps(self):
        text = "訂單編號 20261127，三月十二日送到"
        self.assertEqual(serve.find_mask_spans(text), [])
        self.assertIn("20261127", _covered("電話 20261127", serve.find_mask_spans("電話 20261127")))
        self.assertIn("123456", _covered("驗證碼編號 123456 請收好", serve.find_mask_spans("驗證碼編號 123456 請收好")))

    def test_address_birthdate_passport_card_and_social_are_gold(self):
        import pii_mask_data as data

        examples = {
            "我住香港九龍旺角彌敦道123號8樓A室": "香港九龍旺角彌敦道123號8樓A室",
            "我1990年1月23日出生": "1990年1月23日",
            "護照號碼 E12345678": "E12345678",
            "卡到期日 12/29，CVV 123": "12/29",
            "加我 Telegram @chan_test123": "@chan_test123",
            "住址 九龍灣測試道123號示範大廈8樓A室": "九龍灣測試道123號示範大廈8樓A室",
            "生日 1975-04-23": "1975-04-23",
            "信用卡CVV 000": "信用卡CVV 000",
        }
        for text, expected in examples.items():
            self.assertIn(expected, _covered(text, data.gold_spans(text)))
        self.assertIn("123", _covered("卡到期日 12/29，CVV 123", data.gold_spans("卡到期日 12/29，CVV 123")))

    def test_lure_words_are_cleared_from_model_flags(self):
        from pii_mask_head import clear_lure_chars, spans_from_flags

        text = "驗證碼 123456 請小心"
        flags = [True] * len(text)
        clear_lure_chars(text, flags)
        covered = _covered(text, spans_from_flags(text, flags))
        self.assertIn("123456", covered)
        self.assertNotIn("驗證碼", covered)
        self.assertNotIn("小心", covered)

    def test_single_character_model_flags_are_ignored(self):
        from pii_mask_head import spans_from_flags

        self.assertEqual(spans_from_flags("屋企人話唔使急", [True] + [False] * 7), [])
        text = "叫我阿明"
        flags = [False] * len(text)
        flags[2] = flags[3] = True
        self.assertEqual(spans_from_flags(text, flags), [{"start": 2, "end": 4, "label": "model"}])

    def test_service_and_english_otp_lure_words_are_cleared(self):
        from pii_mask_head import clear_lure_chars, spans_from_flags

        text = "FPS ABC123，Your OTP code is 123456，whatsapp 我"
        flags = [True] * len(text)
        clear_lure_chars(text, flags)
        covered = _covered(text, spans_from_flags(text, flags))
        self.assertNotIn("FPS", covered)
        self.assertNotIn("OTP", covered)
        self.assertNotIn("code", covered)
        self.assertNotIn("whatsapp", covered)
        self.assertIn("ABC123", covered)
        self.assertIn("123456", covered)

    def test_eval_fixture_is_well_formed(self):
        fixture = Path(__file__).resolve().parent / "fixtures" / "pii-mask-eval.json"
        cases = json.loads(fixture.read_text(encoding="utf-8"))["cases"]
        ids = [case["id"] for case in cases]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(cases), 50)
        for case in cases:
            self.assertIn(case["kind"], {"pii", "negative"})
            self.assertIsInstance(case["text"], str)
            self.assertIsInstance(case["expect"], list)
            for secret in case["expect"]:
                self.assertIn(secret, case["text"])


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

    def test_choose_threshold_does_not_trade_away_all_recall_for_clean_negatives(self):
        from pii_mask_head import choose_threshold

        cache = {
            "rows": [
                {"text": "aa", "spans": [{"start": 0, "end": 2, "label": "otp"}], "hard_negative": False},
                {"text": "bb", "spans": [], "hard_negative": True},
            ],
            "offsets": [[(0, 2)], [(0, 2)]],
        }
        threshold, stats = choose_threshold(cache, [[0.45], [0.5]])
        self.assertLessEqual(threshold, 0.45)
        self.assertEqual(stats["recall"], 1.0)
        self.assertEqual(stats["hard_negative_rows_flagged"], 1)


class UnloadedWorkerTests(unittest.TestCase):
    def test_mask_helpers_do_nothing_until_a_head_is_loaded(self):
        self.assertEqual(serve.model_mask_spans("電話91234567"), [])
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
                f"http://127.0.0.1:{port}/v1/mask",
                data=b"not-json",
                method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(bad)
            self.assertEqual(ctx.exception.code, 422)

            for retired_path in ("/v1/score", "/score", "/predict", "/nope"):
                missing = Request(
                    f"http://127.0.0.1:{port}{retired_path}",
                    data=b"{}",
                    method="POST",
                )
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(missing)
                self.assertEqual(ctx.exception.code, 404, retired_path)

            healthz = urlopen(f"http://127.0.0.1:{port}/healthz")
            self.assertEqual(healthz.status, 200)
            healthz.close()

            not_object = Request(
                f"http://127.0.0.1:{port}/v1/mask",
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
                "/v1/mask",
                body=None,
                headers={"content-length": str(serve.MAX_BODY + 1)},
            )
            too_big = conn.getresponse()
            self.assertEqual(too_big.status, 413)
            too_big.read()
            conn.request(
                "POST",
                "/v1/mask",
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


def _install_jevlike_stub():
    import sys
    import types

    if "jevlike" in sys.modules and hasattr(sys.modules["jevlike"], "model"):
        return
    jevlike = types.ModuleType("jevlike")
    model = types.ModuleType("jevlike.model")

    class AttentionHead:
        def __init__(self, *args, **kwargs):
            pass

    model.AttentionHead = AttentionHead
    jevlike.model = model
    sys.modules["jevlike"] = jevlike
    sys.modules["jevlike.model"] = model


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

    def test_truncated_mask_with_fakes(self):
        torch = self.torch
        saved = {
            "encoder": serve._ENCODER,
            "tokenizer": serve._TOKENIZER,
            "device": serve._DEVICE,
            "encoder_id": serve._ENCODER_ID,
            "head": serve._MASK_HEAD,
            "cfg": serve._MASK_CFG,
            "mask_option_cache": serve._MASK_OPTION_CACHE,
        }

        class Tok:
            def __call__(self, text, **kwargs):
                count = len(text) if isinstance(text, list) else 1
                length = 0 if isinstance(text, list) else len(text)
                out = {
                    "input_ids": torch.ones(count, 2, dtype=torch.long),
                    "attention_mask": torch.ones(count, 2, dtype=torch.long),
                }
                if kwargs.get("return_offsets_mapping"):
                    out["offset_mapping"] = torch.tensor([[[0, 0], [0, length]]])
                return out

        class Enc:
            def __call__(self, input_ids, attention_mask):
                batch, length = input_ids.shape[0], input_ids.shape[1]
                return type(
                    "Out",
                    (),
                    {"last_hidden_state": torch.ones(batch, length, 4)},
                )()

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

        try:
            serve._MASK_HEAD = Head()
            serve._ENCODER = Enc()
            serve._TOKENIZER = Tok()
            serve._DEVICE = torch.device("cpu")
            serve._MASK_CFG = {"context_tokens": 8, "mask_threshold": 0.5}
            serve._MASK_OPTION_CACHE = None
            spans = serve.model_mask_spans("ab")
            self.assertIsInstance(spans, list)

            class ShortTok(Tok):
                def __call__(self, text, **kwargs):
                    out = super().__call__(text, **kwargs)
                    if kwargs.get("return_offsets_mapping"):
                        out["offset_mapping"] = torch.tensor([[[0, 0], [0, 1]]])
                    return out

            serve._TOKENIZER = ShortTok()
            with self.assertRaises(serve.MaskTruncated):
                serve.model_mask_spans("abcd")
        finally:
            serve._ENCODER = saved["encoder"]
            serve._TOKENIZER = saved["tokenizer"]
            serve._DEVICE = saved["device"]
            serve._ENCODER_ID = saved["encoder_id"]
            serve._MASK_HEAD = saved["head"]
            serve._MASK_CFG = saved["cfg"]
            serve._MASK_OPTION_CACHE = saved["mask_option_cache"]

    def test_load_runtime_rejects_a_checkpoint_that_is_not_a_head(self):
        torch = self.torch
        saved = {
            "encoder_id": serve._ENCODER_ID,
            "device": serve._DEVICE,
            "encoder": serve._ENCODER,
            "tokenizer": serve._TOKENIZER,
            "head": serve._MASK_HEAD,
            "cfg": serve._MASK_CFG,
            "path": serve._MASK_PATH,
            "threshold": serve._MASK_THRESHOLD,
            "cache": serve._MASK_OPTION_CACHE,
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "not-a-head.pt"
            torch.save({"nope": 1}, path)
            with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(path)}):
                with self.assertRaises(ValueError):
                    serve.load_runtime()
        serve._ENCODER_ID = saved["encoder_id"]
        serve._DEVICE = saved["device"]
        serve._ENCODER = saved["encoder"]
        serve._TOKENIZER = saved["tokenizer"]
        serve._MASK_HEAD = saved["head"]
        serve._MASK_CFG = saved["cfg"]
        serve._MASK_PATH = saved["path"]
        serve._MASK_THRESHOLD = saved["threshold"]
        serve._MASK_OPTION_CACHE = saved["cache"]


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

    def test_zero_width_and_unicode_digit_phones_are_gold(self):
        import pii_mask_data as data

        zero_width = "電話 6123\u200b4567 搵我"
        self.assertIn("6123\u200b4567", _covered(zero_width, data.gold_spans(zero_width)))
        unicode_digits = "號碼 𝟔𝟏𝟐𝟑𝟒𝟓𝟔𝟕 留低"
        self.assertIn("𝟔𝟏𝟐𝟑𝟒𝟓𝟔𝟕", _covered(unicode_digits, data.gold_spans(unicode_digits)))

    def test_generate_split_labels_positives_and_keeps_hard_negatives_clear(self):
        import pii_mask_data as data

        train = data.generate_split("train", 12, 3)
        val = data.generate_split("val", 12, 3)
        generated_negatives = max(10, 12 // 3)
        self.assertEqual(len(train), 12 + 5 + generated_negatives)
        self.assertEqual(len(val), 12 + (len(data._HARD_NEGATIVES) - 5) + generated_negatives)
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

    def test_rejects_the_wrong_task_before_encoder_and_loads_a_pii_head(self):
        import types

        torch = self.torch
        saved = {
            "encoder_id": serve._ENCODER_ID,
            "device": serve._DEVICE,
            "encoder": serve._ENCODER,
            "tokenizer": serve._TOKENIZER,
            "head": serve._MASK_HEAD,
            "cfg": serve._MASK_CFG,
            "path": serve._MASK_PATH,
            "threshold": serve._MASK_THRESHOLD,
            "cache": serve._MASK_OPTION_CACHE,
            "transformers": sys.modules.get("transformers"),
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

        calls = []

        class StubEncoder:
            config = type("Cfg", (), {"hidden_size": 8})()

            def to(self, _device):
                return self

            def eval(self):
                return self

        class StubAutoModel:
            @staticmethod
            def from_pretrained(name):
                calls.append(("model", name))
                return StubEncoder()

        class StubAutoTokenizer:
            @staticmethod
            def from_pretrained(name, use_fast=True):
                calls.append(("tokenizer", name))
                return object()

        transformers_stub = types.ModuleType("transformers")
        transformers_stub.AutoModel = StubAutoModel
        transformers_stub.AutoTokenizer = StubAutoTokenizer

        sys.modules["jevlike.model"].AttentionHead = Head
        sys.modules["transformers"] = transformers_stub
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wrong = Path(tmp) / "wrong.pt"
                torch.save({"config": {"task": "scam"}, "state_dict": {}}, wrong)
                with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(wrong)}):
                    with self.assertRaises(ValueError):
                        serve.load_runtime()
                self.assertEqual(calls, [])

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
                    serve.load_runtime()
                self.assertEqual(serve._MASK_THRESHOLD, 0.42)
                self.assertEqual(serve._MASK_HEAD.state, {"query.weight": 1})
                self.assertEqual(serve._MASK_CFG["context_tokens"], 12)
                self.assertEqual(len(calls), 2)
                with self.assertRaises(ValueError):
                    serve.mask_payload(["ok", 1])
        finally:
            if saved["transformers"] is None:
                sys.modules.pop("transformers", None)
            else:
                sys.modules["transformers"] = saved["transformers"]
            serve._ENCODER_ID = saved["encoder_id"]
            serve._DEVICE = saved["device"]
            serve._ENCODER = saved["encoder"]
            serve._TOKENIZER = saved["tokenizer"]
            serve._MASK_HEAD = saved["head"]
            serve._MASK_CFG = saved["cfg"]
            serve._MASK_PATH = saved["path"]
            serve._MASK_THRESHOLD = saved["threshold"]
            serve._MASK_OPTION_CACHE = saved["cache"]

    def test_main_stops_before_listen_when_the_checkpoint_is_not_a_head(self):
        torch = self.torch
        saved = {
            "encoder_id": serve._ENCODER_ID,
            "device": serve._DEVICE,
            "encoder": serve._ENCODER,
            "tokenizer": serve._TOKENIZER,
            "head": serve._MASK_HEAD,
            "cfg": serve._MASK_CFG,
            "path": serve._MASK_PATH,
            "threshold": serve._MASK_THRESHOLD,
            "cache": serve._MASK_OPTION_CACHE,
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "not-a-head.pt"
            torch.save({"nope": 1}, path)
            with patch.dict(os.environ, {"JEVLIKE_MASK_CKPT": str(path)}):
                with self.assertRaises(ValueError):
                    serve.main()
        serve._ENCODER_ID = saved["encoder_id"]
        serve._DEVICE = saved["device"]
        serve._ENCODER = saved["encoder"]
        serve._TOKENIZER = saved["tokenizer"]
        serve._MASK_HEAD = saved["head"]
        serve._MASK_CFG = saved["cfg"]
        serve._MASK_PATH = saved["path"]
        serve._MASK_THRESHOLD = saved["threshold"]
        serve._MASK_OPTION_CACHE = saved["cache"]


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
