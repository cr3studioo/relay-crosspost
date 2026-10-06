import unittest
from datetime import datetime, timedelta
from worker.core import UTC, in_window, eligible_time, retry_delay, metadata, watermark_free_format, eligibility, seal, unseal

SETTINGS = {"timezone": "Europe/Prague", "start_hour": 7, "end_hour": 21, "last_publication_at": None,
            "instagram_template": "{caption}", "youtube_title_template": "{first_line}", "youtube_description_template": "{caption}"}


class CoreTests(unittest.TestCase):
    def test_prague_window_and_end_boundary(self):
        self.assertFalse(in_window(datetime(2026, 10, 6, 4, 59, tzinfo=UTC), SETTINGS))
        self.assertTrue(in_window(datetime(2026, 10, 6, 5, 0, tzinfo=UTC), SETTINGS))
        self.assertFalse(in_window(datetime(2026, 10, 6, 19, 0, tzinfo=UTC), SETTINGS))

    def test_dst_keeps_local_window(self):
        self.assertTrue(in_window(datetime(2026, 3, 29, 5, 0, tzinfo=UTC), SETTINGS))
        self.assertFalse(in_window(datetime(2026, 10, 25, 5, 0, tzinfo=UTC), SETTINGS))
        self.assertTrue(in_window(datetime(2026, 10, 25, 6, 0, tzinfo=UTC), SETTINGS))

    def test_spacing_and_partial_recovery(self):
        settings = dict(SETTINGS, last_publication_at="2026-10-06T08:30:00Z")
        self.assertFalse(eligible_time(datetime(2026, 10, 6, 9, 29, tzinfo=UTC), settings))
        self.assertTrue(eligible_time(datetime(2026, 10, 6, 9, 30, tzinfo=UTC), settings))
        self.assertTrue(eligible_time(datetime(2026, 10, 6, 8, 45, tzinfo=UTC), settings, partial=True))
        self.assertFalse(eligible_time(datetime(2026, 10, 6, 20, 0, tzinfo=UTC), settings, partial=True))

    def test_retry_backoff_caps_at_an_hour(self):
        self.assertEqual([retry_delay(i) for i in (1, 2, 3, 50)], [timedelta(minutes=m) for m in (15, 30, 60, 60)])

    def test_text_preserves_unicode_hashtags_and_does_not_reexpand_caption_placeholders(self):
        video = {"id": "123", "caption": "\nMorning ☕ {video_id}\n#vlog", "source_url": "https://example.invalid"}
        self.assertEqual(metadata(SETTINGS, video, "instagram")["caption"], video["caption"])
        yt = metadata(SETTINGS, video, "youtube")
        self.assertEqual(yt["title"], "Morning ☕ {video_id}")
        self.assertEqual(yt["description"], video["caption"])
        self.assertFalse(yt["selfDeclaredMadeForKids"])

    def test_media_rejections(self):
        valid = {"duration": 30, "width": 1080, "height": 1920, "video_codec": "h264", "audio_codec": "aac", "fps": 30}
        self.assertIsNone(eligibility(valid))
        for change in ({"duration": 181}, {"width": 1920, "height": 1080}, {"duration": 0}, {"audio_codec": "opus"}, {"fps": 90}):
            self.assertIsNotNone(eligibility(dict(valid, **change)))

    def test_watermarked_unknown_and_audio_only_formats_are_never_selected(self):
        formats = [{"format_id": "download", "format_note": "watermarked", "url": "x", "height": 2000},
                   {"format_id": "unknown", "url": "x", "height": 3000},
                   {"format_id": "h264_high", "url": "x", "height": 2500, "acodec": "none"},
                   {"format_id": "play", "url": "x", "height": 1080}]
        self.assertEqual(watermark_free_format(formats)["format_id"], "play")
        self.assertIsNone(watermark_free_format(formats[:3]))

    def test_encryption_rejects_tampering(self):
        key = "ab" * 32
        encrypted = seal({"token": "fake", "unicode": "☕"}, key)
        self.assertEqual(unseal(encrypted, key), {"token": "fake", "unicode": "☕"})
        with self.assertRaises(Exception):
            unseal(encrypted, "cd" * 32)


if __name__ == "__main__":
    unittest.main()
