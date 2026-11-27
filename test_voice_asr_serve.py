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
    def test_decode_audio_validates_payload(self):
        audio, language = serve.decode_audio({"audioBase64": base64.b64encode(b"abc").decode(), "language": "yue"})
        self.assertEqual(audio, b"abc")
        self.assertEqual(language, "yue")
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": "not base64!"})
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": base64.b64encode(b"abc").decode(), "language": "fr"})
        with self.assertRaises(ValueError):
            serve.decode_audio({"audioBase64": ""})

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
        self.assertTrue(fake_model.path_existed)


if __name__ == "__main__":
    unittest.main()
