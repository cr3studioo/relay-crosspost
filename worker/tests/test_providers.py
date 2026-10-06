import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from worker.core import RelayError, seal
from worker.providers import YouTube, Instagram


class Store:
    key = "ab" * 32
    def __init__(self): self.patches = []
    def heartbeat(self): pass
    def publication_patch(self, video_id, platform, patch): self.patches.append(patch)


class Response:
    def __init__(self, body=None, status=200, headers=None): self.body, self.status_code, self.headers = body, status, headers or {}
    def json(self): return self.body


class ProviderTests(unittest.TestCase):
    @patch.object(YouTube, "credentials", return_value=("channel", "fake-token"))
    def test_completed_resumable_upload_recovers_id_without_a_second_insert(self, _credential):
        import hashlib
        db = Store();provider = YouTube(db)
        with TemporaryDirectory() as folder:
            path = Path(folder) / "sample.mp4";path.write_bytes(b"sample")
            session = seal({"uri": "https://www.googleapis.com/upload/session", "size": 6, "sha256": hashlib.sha256(b"sample").hexdigest()}, db.key)
            with patch("worker.providers.api", return_value=Response({"id": "recovered"})) as request:
                provider.prepare({"id": "1"}, {"state": "uploading", "encrypted_session": session}, path, {})
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[0], "PUT")
            self.assertEqual(db.patches[-1]["external_id"], "recovered")

    @patch.object(YouTube, "credentials", return_value=("channel", "fake-token"))
    def test_incomplete_resumable_upload_uses_the_confirmed_offset(self, _credential):
        import hashlib
        db = Store();provider = YouTube(db)
        with TemporaryDirectory() as folder:
            path = Path(folder) / "sample.mp4";path.write_bytes(b"sample")
            session = seal({"uri": "https://www.googleapis.com/upload/session", "size": 6, "sha256": hashlib.sha256(b"sample").hexdigest()}, db.key)
            with patch("worker.providers.api", side_effect=[Response(status=308, headers={"Range": "bytes=0-2"}), Response({"id": "uploaded"})]) as request:
                provider.prepare({"id": "1"}, {"state": "uploading", "encrypted_session": session}, path, {})
            self.assertEqual(request.call_args.kwargs["headers"]["Content-Range"], "bytes 3-5/6")
            self.assertEqual(db.patches[-1]["external_id"], "uploaded")

    @patch.object(Instagram, "credentials", return_value=("account", "fake-token"))
    @patch.object(Instagram, "status", return_value="PUBLISHED")
    def test_unknown_instagram_result_cannot_republish(self, _status, _credential):
        provider = Instagram(Store())
        with patch("worker.providers.api") as request:
            with self.assertRaises(RelayError) as caught:
                provider.reconcile({"id": "1"}, {"external_id": "container"})
            self.assertTrue(caught.exception.permanent)
            request.assert_not_called()

    @patch.object(Instagram, "credentials", return_value=("account", "fake-token"))
    @patch.object(Instagram, "status", return_value="EXPIRED")
    def test_expired_unpublished_container_resets_preparation_without_publishing(self, _status, _credential):
        db = Store();provider = Instagram(db)
        with patch("worker.providers.api") as request:
            provider.prepare({"id": "1"}, {"external_id": "container", "state": "ready"}, None, {})
            request.assert_not_called()
        self.assertEqual(db.patches[-1]["state"], "pending")


if __name__ == "__main__": unittest.main()
