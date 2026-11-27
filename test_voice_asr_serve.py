#!/usr/bin/env python3
"""Offline helpers for voice_asr_serve.py; no model download."""

import base64
import os
import sys
import types
import unittest
from unittest.mock import patch

import voice_asr_serve as serve


class VoiceAsrServeTest(unittest.TestCase):
    def test_resolve_wsyue_model_downloads_only_the_cantonese_subfolder(self):
        calls = []

        def fake_download(repo, allow_patterns):
            calls.append((repo, allow_patterns))
            return "/tmp/wsyue"

        resolved = serve.resolve_model_path("ASLP-lab/WSYue-ASR/sensevoice_small_yue", fake_download)
        self.assertEqual(resolved, os.path.join("/tmp/wsyue", "sensevoice_small_yue"))
        self.assertEqual(calls, [("ASLP-lab/WSYue-ASR", ["sensevoice_small_yue/*"])])
        self.assertEqual(serve.resolve_model_path("FunAudioLLM/SenseVoiceSmall", fake_download), "FunAudioLLM/SenseVoiceSmall")

    def test_correct_command_transcript_only_repairs_command_homophones(self):
        self.assertEqual(serve.correct_command_transcript("唔好风。"), "唔好封。")
        self.assertEqual(serve.correct_command_transcript("风佢。"), "封佢。")
        self.assertEqual(serve.correct_command_transcript("解风91234567"), "解封91234567")
        self.assertEqual(serve.correct_command_transcript("唔好疯"), "唔好封")
        self.assertEqual(serve.correct_command_transcript("外面刮風"), "外面刮風")


    def test_qwen_backend_uses_context_only_when_consistent_with_plain_transcript(self):
        class FakeQwen:
            def __init__(self, contextual, plain):
                self.contextual = contextual
                self.plain = plain
                self.calls = []

            def transcribe(self, **kwargs):
                self.calls.append(kwargs)
                text = self.contextual if kwargs["context"] else self.plain
                return [types.SimpleNamespace(text=text)]

        fake = FakeQwen("唔好封", "唔好疯")
        with patch.object(serve, "BACKEND", "qwen"):
            with patch.object(serve, "convert_to_wav", return_value=b"wav"), patch.object(serve, "load_model", return_value=fake):
                text = serve.transcribe_audio(b"ogg", "yue", "封佢, 唔好封")
        self.assertEqual(text, "唔好封")
        self.assertEqual(fake.calls[0]["language"], "Cantonese")
        self.assertEqual(fake.calls[0]["context"], "封佢, 唔好封")
        self.assertEqual(fake.calls[1]["context"], "")

    def test_qwen_backend_maps_worker_language_codes(self):
        self.assertEqual(serve.qwen_language_name("yue"), "Cantonese")
        self.assertEqual(serve.qwen_language_name("zh"), "Chinese")
        self.assertEqual(serve.qwen_language_name("en"), "English")
        self.assertIsNone(serve.qwen_language_name("auto"))

    def test_qwen_backend_rejects_context_hallucination_on_non_speech(self):
        class FakeQwen:
            def transcribe(self, **kwargs):
                return [types.SimpleNamespace(text="封佢。" if kwargs["context"] else "係。")]

        with patch.object(serve, "BACKEND", "qwen"):
            with patch.object(serve, "convert_to_wav", return_value=b"wav"), patch.object(serve, "load_model", return_value=FakeQwen()):
                text = serve.transcribe_audio(b"ogg", "yue", "封佢")
        self.assertEqual(text, "係。")

    def test_contextual_transcript_consistency(self):
        self.assertTrue(serve.contextual_transcript_consistent("唔好封。", "唔好疯。"))
        self.assertTrue(serve.contextual_transcript_consistent("封佢。", "风佢。"))
        self.assertFalse(serve.contextual_transcript_consistent("封佢。", "係。"))
        self.assertFalse(serve.contextual_transcript_consistent("解封。", ""))
        self.assertFalse(serve.contextual_transcript_consistent("封佢。", "唔封佢。"))
        self.assertFalse(serve.contextual_transcript_consistent("解封。", "唔好解封。"))
        self.assertFalse(
            serve.contextual_transcript_consistent(
                "封佢，唔好封，解封九一二三四五六七。",
                "嗯。",
            )
        )

    def test_decode_audio_validates_payload(self):
        audio, language, context = serve.decode_audio({"audioBase64": base64.b64encode(b"abc").decode(), "language": "yue", "context": "封佢"})
        self.assertEqual(audio, b"abc")
        self.assertEqual(language, "yue")
        self.assertEqual(context, "封佢")
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": "not base64!"})
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": base64.b64encode(b"abc").decode(), "language": "fr"})
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": ""})
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": base64.b64encode(b"abc").decode(), "context": 1})

    def test_transcribe_audio_uses_funasr_and_cleans_text(self):
        class FakeModel:
            def generate(self, **kwargs):
                self.kwargs = kwargs
                self.path_existed = os.path.exists(kwargs["input"])
                return [{"text": "<|yue|><|NEUTRAL|><|Speech|><|withitn|>解除封鎖"}]

        fake_model = FakeModel()
        postprocess = types.ModuleType("funasr.utils.postprocess_utils")
        postprocess.rich_transcription_postprocess = lambda text: text.split("|>")[-1]
        utils = types.ModuleType("funasr.utils")
        utils.postprocess_utils = postprocess
        funasr = types.ModuleType("funasr")
        funasr.utils = utils
        modules = {
            "funasr": funasr,
            "funasr.utils": utils,
            "funasr.utils.postprocess_utils": postprocess,
        }
        with patch.dict(sys.modules, modules):
            with patch.object(serve, "convert_to_wav", return_value=b"wav"), patch.object(serve, "load_model", return_value=fake_model):
                text = serve.transcribe_audio(b"ogg", "yue")
        self.assertEqual(text, "解除封鎖")
        self.assertEqual(fake_model.kwargs["language"], "yue")
        self.assertIsNone(fake_model.kwargs["output_dir"])
        self.assertTrue(fake_model.path_existed)


if __name__ == "__main__":
    unittest.main()
