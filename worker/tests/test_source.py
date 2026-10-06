import os
import unittest
from unittest.mock import MagicMock, patch

from worker.core import RelayError
from worker.source import Source

PROFILE = "https://www.tiktok.com/@testaccount"
CHANNEL = "MS4wLjABAAAA_test_account_id"


class SourceIdentityTests(unittest.TestCase):
    def test_hint_is_bound_to_profile_and_rejects_another_uploader(self):
        entry = {"id": "123", "timestamp": 1700000000, "uploader_url": PROFILE}
        ydl = MagicMock()
        ydl.extract_info.return_value = {"entries": [entry]}
        with patch.dict(os.environ, {"TIKTOK_PROFILE_URL": PROFILE, "TIKTOK_CHANNEL_ID": CHANNEL}), \
                patch("yt_dlp.YoutubeDL") as factory:
            factory.return_value.__enter__.return_value = ydl
            self.assertEqual(list(Source().list(PROFILE))[0]["id"], "123")
            ydl.extract_info.assert_called_with("tiktokuser:" + CHANNEL, download=False)
            ydl.extract_info.return_value = {"entries": [dict(entry, uploader_url="https://www.tiktok.com/@someoneelse")]}
            with self.assertRaises(RelayError) as error:
                list(Source().list(PROFILE))
            self.assertEqual(error.exception.code, "source_account_mismatch")
            self.assertTrue(error.exception.permanent)

    def test_hint_cannot_be_reused_for_another_requested_profile(self):
        ydl = MagicMock()
        ydl.extract_info.return_value = {"entries": []}
        with patch.dict(os.environ, {"TIKTOK_PROFILE_URL": PROFILE, "TIKTOK_CHANNEL_ID": CHANNEL}), \
                patch("yt_dlp.YoutubeDL") as factory:
            factory.return_value.__enter__.return_value = ydl
            requested = "https://www.tiktok.com/@anotheraccount"
            self.assertEqual(list(Source().list(requested)), [])
            ydl.extract_info.assert_called_with(requested, download=False)
