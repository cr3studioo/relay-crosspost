import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from worker.core import RelayError, seal
from worker.providers import YouTube, Instagram, api


class Store:
    key = "ab" * 32
    def __init__(self): self.patches = []; self.visibility = "public"; self.cleared = False; self.expired = False
    def heartbeat(self): pass
    def publication_patch(self, video_id, platform, patch): self.patches.append(patch)
    def settings(self): return {"youtube_visibility": self.visibility}
    def refresh_youtube_publication(self, video_id, visibility): self.patches.append({"youtube_visibility": visibility})
    def clear_youtube_data(self): self.cleared = True
    def expire_youtube_data(self): self.expired = True


class Response:
    def __init__(self, body=None, status=200, headers=None): self.body, self.status_code, self.headers = body, status, headers or {}
    def json(self): return self.body


class ProviderTests(unittest.TestCase):
    @patch.object(YouTube, "credentials", return_value=("channel", "fake-token"))
    def test_manual_public_visibility_is_not_a_relay_publication(self, _credential):
        db = Store(); provider = YouTube(db)
        with patch("worker.providers.api", return_value=Response({"items": [{"status": {"privacyStatus": "public", "uploadStatus": "processed"}, "processingDetails": {"processingStatus": "succeeded"}}]})) as request:
            provider.prepare({"id": "1"}, {"external_id": "existing", "state": "ready"}, None, {})
        self.assertEqual(request.call_args.args[0], "GET")
        self.assertFalse(any(p.get("state") == "published" for p in db.patches))
        self.assertEqual(db.patches[-1]["state"], "ready")

    @patch.object(YouTube, "credentials", return_value=("channel", "fake-token"))
    def test_weekly_refresh_updates_existing_references_without_uploading(self, _credential):
        db = Store(); provider = YouTube(db)
        record = {"api_checked_at": "2026-01-01T00:00:00Z"}
        with patch.object(db, "request", create=True, side_effect=[[record], None]) as database, patch.object(db, "stale_youtube_publications", create=True, return_value=[{"video_id": "1", "external_id": "existing"}]), patch("worker.providers.api", side_effect=[Response({"items": [{"id": "channel", "snippet": {"title": "Renamed"}}]}), Response({"items": [{"id": "existing", "status": {"privacyStatus": "private"}}]})]) as request:
            provider.maintain(True)
        self.assertEqual(database.call_args.kwargs["json"]["account_label"], "Renamed")
        self.assertEqual([c.args[0] for c in request.call_args_list], ["GET", "GET"])
        self.assertEqual(db.patches[-1]["youtube_visibility"], "private")
        self.assertTrue(db.expired)

    @patch.object(YouTube, "credentials", return_value=("channel", "fake-token"))
    def test_visibility_updates_known_upload_and_confirms_actual_target(self, _credential):
        for target in ("public", "private", "unlisted"):
            db = Store(); db.visibility = target; provider = YouTube(db)
            with patch("worker.providers.api", side_effect=[Response({}), Response({"items": [{"status": {"privacyStatus": target}}]})]) as request:
                provider.publish({"id": "1"}, {"external_id": "existing"})
            self.assertEqual(request.call_args_list[0].kwargs["json"]["status"]["privacyStatus"], target)
            self.assertEqual(db.patches[-2]["state"], "published")
            self.assertIsNone(db.patches[-2]["public_url"]) if target == "private" else self.assertIn("existing", db.patches[-2]["public_url"])
            self.assertEqual(db.patches[-1]["youtube_visibility"], target)

    @patch.object(YouTube, "credentials", return_value=("channel", "fake-token"))
    def test_google_private_only_restriction_cannot_be_marked_public(self, _credential):
        db = Store(); provider = YouTube(db)
        with patch("worker.providers.api", side_effect=[Response({}), Response({"items": [{"status": {"privacyStatus": "private"}}]})]):
            with self.assertRaises(RelayError) as caught: provider.publish({"id": "1"}, {"external_id": "existing"})
        self.assertEqual(caught.exception.code, "youtube_publication_restricted")
        self.assertFalse(any(p.get("state") == "published" for p in db.patches))

    def test_invalid_grant_is_recognized_but_temporary_errors_do_not_mean_revocation(self):
        response = Response({"error": "invalid_grant"}, status=400)
        with patch("worker.providers.requests.request", return_value=response):
            with self.assertRaises(RelayError) as caught: api("POST", "https://oauth2.googleapis.com/token")
        self.assertEqual(caught.exception.code, "authorization_revoked")
        response.body = {"error": "temporarily_unavailable"}; response.status_code = 503
        with patch("worker.providers.requests.request", return_value=response):
            with self.assertRaises(RelayError) as caught: api("POST", "https://oauth2.googleapis.com/token")
        self.assertNotEqual(caught.exception.code, "authorization_revoked")

    def test_invalid_refresh_clears_authorized_data(self):
        db = Store(); provider = YouTube(db)
        with patch.object(db, "credentials", create=True, return_value=({"account_id": "channel"}, {"refresh_token": "fake"})), patch.dict("os.environ", {"GOOGLE_CLIENT_ID": "fake", "GOOGLE_CLIENT_SECRET": "fake"}), patch("worker.providers.api", side_effect=RelayError("authorization_revoked", permanent=True)):
            with self.assertRaises(RelayError): provider.credentials()
        self.assertTrue(db.cleared)

    def test_maintenance_retries_pending_revoke_and_runs_retention_while_paused(self):
        db = Store(); provider = YouTube(db)
        with patch.object(db, "settings", return_value={"youtube_revoke_requested_at": "2026-10-06T00:00:00Z"}), patch.object(db, "request", create=True, return_value=[{"encrypted_payload": seal({"refresh_token": "fake"}, db.key)}]), patch("worker.providers.api", return_value=Response({})) as request:
            provider.maintain(False)
        self.assertEqual(request.call_args.args[1], "https://oauth2.googleapis.com/revoke")
        self.assertTrue(db.cleared)
        self.assertTrue(db.expired)

    def test_failed_revoke_retains_token_for_retry_and_runs_retention(self):
        db = Store(); provider = YouTube(db)
        with patch.object(db, "settings", return_value={"youtube_revoke_requested_at": "2026-10-06T00:00:00Z"}), patch.object(db, "request", create=True, return_value=[{"encrypted_payload": seal({"refresh_token": "fake"}, db.key)}]), patch("worker.providers.api", side_effect=RelayError("platform_network_error")):
            with self.assertRaises(RelayError): provider.maintain(False)
        self.assertFalse(db.cleared)
        self.assertTrue(db.expired)
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
