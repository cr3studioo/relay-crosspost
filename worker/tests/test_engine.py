import copy
import threading
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from worker.core import UTC, RelayError
from worker.engine import Engine

INSTANT = datetime(2026, 10, 6, 8, tzinfo=UTC)


class FakeStore:
    def __init__(self):
        self.config = {"source_profile": "https://www.tiktok.com/@test", "import_complete": False, "paused": False,
                       "integrations_verified": True, "youtube_audit_confirmed": True, "timezone": "Europe/Prague",
                       "enabled_platforms": ["instagram", "youtube"],
                       "policy_version": "2026-10-06", "policy_accepted_at": "2026-10-06T07:00:00Z", "youtube_visibility": "public",
                       "start_hour": 7, "end_hour": 21, "last_publication_at": None,
                       "instagram_template": "{caption}", "youtube_title_template": "{first_line}", "youtube_description_template": "{caption}"}
        self.videos, self.pubs, self.messages = {}, {}, []
        self.lock = threading.Lock()
        self.available = True
    def acquire(self): return self.available
    def release(self): pass
    def heartbeat(self): pass
    def settings(self): return copy.deepcopy(self.config)
    def settings_patch(self, values): self.config.update(values)
    def known_ids(self): return set(self.videos)
    def ingest(self, video):
        self.videos.setdefault(video["id"], dict(video, state="queued"))
        for platform in ("instagram", "youtube"):
            self.pubs.setdefault((video["id"], platform), {"platform": platform, "required": platform in self.config["enabled_platforms"], "state": "pending", "external_id": None, "attempts": 0})
    def head(self):
        return next(iter(sorted((v for v in self.videos.values() if v["state"] not in ("published", "skipped")), key=lambda v: (v["source_created_at"], v["id"]))), None)
    def video(self, video_id): return self.videos.get(video_id)
    def video_patch(self, video_id, state, reason=None): self.videos[video_id].update(state=state, reason=reason)
    def publications(self, video_id): return copy.deepcopy([p for (id_, _), p in self.pubs.items() if id_ == video_id])
    def latest_other_publication(self, video_id):
        return max((p["published_at"] for (id_, _), p in self.pubs.items() if id_ != video_id and p["state"] == "published"), default=None)
    def publication_patch(self, video_id, platform, patch):
        with self.lock:
            self.pubs[(video_id, platform)].update(patch)
            if patch.get("state") == "published":
                self.config["last_publication_at"] = patch["published_at"]
            if all(p["state"] == "published" for (id_, _), p in self.pubs.items() if id_ == video_id and p["required"]):
                self.videos[video_id]["state"] = "published"
    def event(self, level, message, video_id=None): self.messages.append((level, message, video_id))


POSTS = [{"id": "2", "source_created_at": "2026-10-02T00:00:00Z", "source_url": "x", "caption": "Newer"},
         {"id": "1", "source_created_at": "2026-10-01T00:00:00Z", "source_url": "x", "caption": "Older"}]


class FakeSource:
    check = lambda: None
    def __init__(self, incomplete=False, download_error=None): self.incomplete, self.download_error = incomplete, download_error
    def list(self, _profile):
        for item in POSTS:
            yield item
            if self.incomplete: raise RelayError("tiktok_listing_failed")
    def download(self, video, folder):
        if self.download_error: raise self.download_error
        path = Path(folder) / "sample.mp4";path.write_bytes(b"fake-media")
        return path, {}


class FakeProvider:
    def __init__(self, store, platform, fail=None): self.store, self.platform, self.fail, self.calls = store, platform, fail, []
    def prepare(self, video, pub, path, metadata):
        self.store.publication_patch(video["id"], self.platform, {"state": "ready", "external_id": "fake", "rendered_metadata": metadata})
    def maintain(self, accepted): pass
    def publish(self, video, pub):
        if hasattr(self, "before_publish"):self.before_publish()
        self.calls.append(video["id"])
        self.store.publication_patch(video["id"], self.platform, {"state": "publishing", "resume_state": "publishing"})
        if self.fail:
            error = self.fail
            if not error.uncertain:self.store.publication_patch(video["id"], self.platform, {"state": "ready", "resume_state": "ready"})
            raise error
        self.store.publication_patch(video["id"], self.platform, {"state": "published", "published_at": INSTANT.isoformat(), "confirmation_origin": "relay_api", "resume_state": None})
    def reconcile(self, video, pub):
        raise RelayError("publication_outcome_unknown", permanent=True, uncertain=True)


class EngineTests(unittest.TestCase):
    def create(self, source=None):
        db = FakeStore()
        providers = {p: FakeProvider(db, p) for p in ("instagram", "youtube")}
        return db, providers, Engine(db, source or FakeSource(), providers)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_oldest_first_duplicate_discovery_and_no_catchup_burst(self, _clock):
        db, providers, engine = self.create()
        engine.tick();engine.tick()
        self.assertTrue(db.config["import_complete"])
        self.assertEqual(len(db.videos), 2)
        self.assertEqual(providers["instagram"].calls, ["1"])
        self.assertEqual(providers["youtube"].calls, ["1"])
        self.assertEqual(db.videos["1"]["state"], "published")

    @patch("worker.engine.now", return_value=INSTANT)
    def test_partial_failure_only_retries_missing_destination_and_blocks_later_video(self, clock):
        db, providers, engine = self.create()
        providers["youtube"].fail = RelayError("platform_network_error")
        engine.tick();engine.tick()
        self.assertEqual(providers["instagram"].calls, ["1"])
        self.assertEqual(providers["youtube"].calls, ["1"])
        self.assertEqual(db.head()["id"], "1")
        providers["youtube"].fail = None
        clock.return_value = datetime(2026, 10, 6, 8, 15, tzinfo=UTC)
        engine.tick()
        self.assertEqual(providers["instagram"].calls, ["1"])
        self.assertEqual(providers["youtube"].calls, ["1", "1"])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_incomplete_initial_import_never_publishes(self, _clock):
        db, providers, engine = self.create(FakeSource(incomplete=True));engine.tick()
        self.assertFalse(db.config["import_complete"])
        self.assertFalse(providers["instagram"].calls)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_pause_and_audit_gate_prevent_publication(self, _clock):
        for field in ("paused", "youtube_audit_confirmed", "integrations_verified"):
            db, providers, engine = self.create();db.config[field] = field == "paused";engine.tick()
            self.assertFalse(providers["instagram"].calls)

    @patch("worker.engine.now", return_value=datetime(2026, 10, 6, 20, tzinfo=UTC))
    def test_no_publication_after_window_even_in_verification(self, _clock):
        db, providers, engine = self.create();engine.tick("1")
        self.assertFalse(providers["instagram"].calls)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_verification_publishes_one_selected_video_and_keeps_queue_paused(self, _clock):
        db, providers, engine = self.create();db.config.update(paused=True, integrations_verified=False)
        engine.tick("2")
        self.assertTrue(db.config["integrations_verified"])
        self.assertTrue(db.config["paused"])
        self.assertEqual(providers["instagram"].calls, ["2"])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_unknown_publish_outcome_is_not_blindly_repeated(self, clock):
        db, providers, engine = self.create()
        providers["instagram"].fail = RelayError("platform_network_error", uncertain=True)
        engine.tick()
        clock.return_value = datetime(2026, 10, 6, 9, tzinfo=UTC)
        engine.tick()
        self.assertEqual(providers["instagram"].calls, ["1"])
        self.assertEqual(db.pubs[("1", "instagram")]["state"], "attention")
        self.assertEqual(db.head()["id"], "1")

    @patch("worker.engine.now", return_value=INSTANT)
    def test_skips_unusable_source_without_uploading(self, _clock):
        db, providers, engine = self.create(FakeSource(download_error=RelayError("no_watermark_free_source", permanent=True)))
        engine.tick()
        self.assertEqual(db.videos["1"]["state"], "skipped")
        self.assertFalse(providers["instagram"].calls)

    def test_overlapping_worker_does_nothing(self):
        db, providers, engine = self.create();db.available = False
        self.assertEqual(engine.tick(), "Another worker is active")
        self.assertFalse(db.videos)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_repeated_scans_do_not_rewrite_already_imported_ids(self, _clock):
        db, providers, engine = self.create();db.config["paused"] = True
        with patch.object(db, "ingest", wraps=db.ingest) as ingest:
            engine.tick();engine.tick()
            self.assertEqual(ingest.call_count, 2)

    @patch("worker.engine.time.sleep")
    @patch("worker.engine.now", return_value=INSTANT)
    def test_processing_can_finish_and_publish_in_the_same_tick(self, _clock, sleep):
        db, providers, engine = self.create()
        for provider in providers.values():
            original = provider.prepare
            def prepare(video, pub, path, metadata, provider=provider, original=original):
                if pub["state"] == "pending":
                    db.publication_patch(video["id"], provider.platform, {"state": "processing", "external_id": "fake", "rendered_metadata": metadata})
                else:
                    original(video, pub, path, metadata)
            provider.prepare = prepare
        engine.tick()
        self.assertEqual(db.videos["1"]["state"], "published")
        sleep.assert_called_once_with(60)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_retrying_an_old_partial_after_skipping_still_respects_other_video_spacing(self, _clock):
        db, providers, engine = self.create()
        for video in POSTS:db.ingest(video)
        db.config["import_complete"] = True
        db.publication_patch("1", "instagram", {"state": "published", "published_at": "2026-10-06T06:00:00Z"})
        db.publication_patch("2", "youtube", {"state": "published", "published_at": "2026-10-06T07:45:00Z"})
        engine.process(db.video("1"))
        self.assertFalse(providers["youtube"].calls)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_youtube_only_completes_without_instagram_and_keeps_hourly_spacing(self, clock):
        db, providers, engine = self.create()
        db.config["enabled_platforms"] = ["youtube"]
        del providers["instagram"]  # There is no Instagram integration to call.
        engine.tick();engine.tick()
        self.assertEqual(db.videos["1"]["state"], "published")
        self.assertEqual(db.pubs[("1", "instagram")]["state"], "pending")
        self.assertEqual(providers["youtube"].calls, ["1"])
        clock.return_value = datetime(2026, 10, 6, 9, tzinfo=UTC)
        engine.tick();engine.tick()
        self.assertEqual(providers["youtube"].calls, ["1", "2"])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_disabled_instagram_errors_do_not_stall_youtube_verification(self, _clock):
        db, providers, engine = self.create()
        db.config.update(enabled_platforms=["youtube"], paused=True, integrations_verified=False)
        for video in POSTS: db.ingest(video)
        db.pubs[("1", "instagram")].update(state="attention", error_code="account_not_connected")
        engine.tick("1")
        self.assertTrue(db.config["integrations_verified"])
        self.assertTrue(db.config["paused"])
        self.assertEqual(providers["youtube"].calls, ["1"])
        self.assertEqual(providers["instagram"].calls, [])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_completed_youtube_post_cannot_verify_a_new_instagram_destination(self, _clock):
        db, providers, engine = self.create()
        db.config["enabled_platforms"] = ["youtube"]
        engine.tick()
        db.config.update(enabled_platforms=["instagram", "youtube"], integrations_verified=False, paused=True)
        result = engine.tick("1")
        self.assertIn("test_video_destinations_mismatch", result)
        self.assertFalse(db.config["integrations_verified"])
        self.assertEqual(providers["youtube"].calls, ["1"])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_instagram_only_does_not_require_a_youtube_audit(self, _clock):
        db, providers, engine = self.create()
        db.config.update(enabled_platforms=["instagram"], youtube_audit_confirmed=False)
        engine.tick()
        self.assertEqual(db.videos["1"]["state"], "published")
        self.assertEqual(providers["instagram"].calls, ["1"])
        self.assertEqual(providers["youtube"].calls, [])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_policy_gate_prevents_discovery_and_verification_uploads(self, _clock):
        db, providers, engine = self.create()
        db.config["policy_version"] = None
        with patch.object(engine.source, "list", wraps=engine.source.list) as discovery:
            result = engine.tick("1")
            self.assertIn("accept the policies", result)
            discovery.assert_not_called()
        self.assertFalse(db.videos)
        self.assertFalse(providers["youtube"].calls)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_private_visibility_can_verify_without_public_upload_audit(self, _clock):
        db, providers, engine = self.create()
        db.config.update(enabled_platforms=["youtube"], youtube_visibility="private", youtube_audit_confirmed=False, paused=True)
        engine.tick("1")
        self.assertEqual(providers["youtube"].calls, ["1"])
        self.assertTrue(db.config["integrations_verified"])

    @patch("worker.engine.now", return_value=INSTANT)
    def test_unlisted_visibility_still_requires_public_upload_audit(self, _clock):
        db, providers, engine = self.create()
        db.config.update(enabled_platforms=["youtube"], youtube_visibility="unlisted", youtube_audit_confirmed=False)
        engine.tick()
        self.assertFalse(providers["youtube"].calls)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_pending_revocation_stops_discovery_and_uploads(self, _clock):
        db, providers, engine = self.create()
        db.config["youtube_revoke_requested_at"] = INSTANT.isoformat()
        result = engine.tick("1")
        self.assertIn("disconnection is pending", result)
        self.assertFalse(db.videos)

    @patch("worker.engine.now", return_value=INSTANT)
    def test_manual_completion_does_not_verify_relay_and_cannot_reupload(self, _clock):
        db, providers, engine = self.create()
        db.config.update(enabled_platforms=["youtube"], integrations_verified=False, paused=True)
        for video in POSTS: db.ingest(video)
        db.publication_patch("1", "youtube", {"state": "published", "external_id": "existing", "published_at": INSTANT.isoformat(), "confirmation_origin": "manual"})
        result = engine.tick("1")
        self.assertIn("test_video_published_manually_choose_another", result)
        self.assertFalse(db.config["integrations_verified"])
        self.assertFalse(providers["youtube"].calls)
        self.assertEqual(db.head()["id"], "2")


if __name__ == "__main__": unittest.main()
