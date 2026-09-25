#!/usr/bin/env python3
"""Mapping helpers for jevlike_serve.py (no torch / no encoder download)."""

import unittest

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


if __name__ == "__main__":
    unittest.main()
