import time
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from .core import RelayError, BudgetReached, now, parse_date, eligible_time, retry_delay, metadata

SKIPPABLE = {"no_video_source", "no_watermark_free_source", "invalid_media", "ineligible_media"}


class Engine:
    def __init__(self, store, source, providers, budget_seconds=540):
        self.store, self.source, self.providers = store, source, providers
        self.deadline = time.monotonic() + budget_seconds
        self.last_heartbeat = 0
        source.check = self.check

    def check(self):
        if time.monotonic() >= self.deadline:
            raise BudgetReached()
        if time.monotonic() - self.last_heartbeat >= 30:
            self.store.heartbeat()
            self.last_heartbeat = time.monotonic()

    def failure(self, video, platform, error):
        pub = next(p for p in self.store.publications(video["id"]) if p["platform"] == platform)
        if pub["state"] == "published":
            return
        attempt = pub.get("attempts", 0) + 1
        resume = pub.get("resume_state") if pub["state"] in ("retry", "attention") else pub["state"]
        patch = {"state": "attention" if error.permanent else "retry", "resume_state": resume,
                 "attempts": attempt, "error_code": error.code,
                 "next_retry_at": None if error.permanent else (now() + retry_delay(attempt)).isoformat()}
        self.store.publication_patch(video["id"], platform, patch)
        if error.permanent:
            self.store.video_patch(video["id"], "attention", error.code)
        self.store.event("error" if error.permanent else "warning", f"{platform}: {error.code}", video["id"])

    def discover(self, settings):
        if not settings["source_profile"]:
            return False
        try:
            count = 0
            known = self.store.known_ids()
            for item in self.source.list(settings["source_profile"]):
                self.check()
                if item["id"] not in known:
                    self.store.ingest(item)
                    known.add(item["id"])
                count += 1
            self.store.settings_patch({"import_complete": True, "last_discovery_at": now().isoformat(), "worker_error": None})
            if not settings["import_complete"]:
                self.store.event("info", f"Initial history import completed: {count} posts discovered.")
            return True
        except RelayError as error:
            self.store.settings_patch({"worker_error": error.code})
            self.store.event("warning", "TikTok discovery failed; history import remains incomplete." if not settings["import_complete"] else "TikTok discovery failed; previously queued videos remain available.")
            return settings["import_complete"]

    def process(self, video, verify=False):
        pubs = self.store.publications(video["id"])
        if any(p["state"] == "attention" for p in pubs):
            return
        # A crashed publishing call must be reconciled before creating or publishing anything.
        for pub in pubs:
            if pub["state"] == "publishing" or (pub["state"] == "retry" and pub.get("resume_state") == "publishing"):
                if parse_date(pub.get("next_retry_at")) and now() < parse_date(pub["next_retry_at"]):
                    continue
                try:
                    self.providers[pub["platform"]].reconcile(video, pub)
                except RelayError as error:
                    self.failure(video, pub["platform"], error)
        pubs = self.store.publications(video["id"])
        if all(p["state"] == "published" for p in pubs):
            if verify:
                self.store.settings_patch({"integrations_verified": True})
            return
        if any(p["state"] == "attention" for p in pubs):
            return
        waiting = [p for p in pubs if p["state"] != "published"]
        if any(p.get("next_retry_at") and now() < parse_date(p["next_retry_at"]) for p in waiting):
            return
        self.store.video_patch(video["id"], "preparing")
        needs_file = any((p.get("resume_state") if p["state"] == "retry" else p["state"]) in ("pending", "uploading") for p in waiting)
        with TemporaryDirectory(prefix="relay-") as folder:
            path = None
            if needs_file:
                try:
                    path, _properties = self.source.download(video, folder)
                except RelayError as error:
                    if error.code in SKIPPABLE and not any(p["state"] == "published" for p in pubs):
                        self.store.video_patch(video["id"], "skipped", error.detail or error.code)
                        self.store.event("warning", "Skipped: " + error.code, video["id"])
                    else:
                        for pub in waiting:
                            self.failure(video, pub["platform"], error)
                    return
            for pub in waiting:
                self.check()
                platform = pub["platform"]
                if pub["state"] == "retry":
                    self.store.publication_patch(video["id"], platform, {"state": pub.get("resume_state") or "pending", "next_retry_at": None})
                    pub = next(p for p in self.store.publications(video["id"]) if p["platform"] == platform)
                try:
                    frozen = pub.get("rendered_metadata") or metadata(self.store.settings(), video, platform)
                    self.providers[platform].prepare(video, pub, path, frozen)
                except RelayError as error:
                    self.failure(video, platform, error)
            pubs = self.store.publications(video["id"])
            # Give ordinary processing a chance to finish in this same check,
            # rather than adding an unnecessary fifteen-minute publication delay.
            for _ in range(2):
                processing = [p for p in pubs if p["state"] == "processing"]
                if not processing or any(p["state"] in ("retry", "attention", "pending", "uploading") for p in pubs):
                    break
                if self.deadline - time.monotonic() < 65:
                    break
                time.sleep(60)
                self.check()
                for pub in processing:
                    try:
                        self.providers[pub["platform"]].prepare(video, pub, None, pub.get("rendered_metadata") or metadata(self.store.settings(), video, pub["platform"]))
                    except RelayError as error:
                        self.failure(video, pub["platform"], error)
                pubs = self.store.publications(video["id"])
            if not all(p["state"] in ("ready", "published") for p in pubs):
                return
            settings = self.store.settings()
            partial = any(p["state"] == "published" for p in pubs)
            settings["last_publication_at"] = self.store.latest_other_publication(video["id"])
            if (settings["paused"] and not verify) or not settings["youtube_audit_confirmed"] or not eligible_time(now(), settings):
                return
            # Both sources are ready. Start the two independent publication calls together.
            ready = [p for p in pubs if p["state"] == "ready"]
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [(p["platform"], pool.submit(self.publish_guarded, video, p, verify, partial)) for p in ready]
                for platform, future in futures:
                    try:
                        future.result()
                    except RelayError as error:
                        self.failure(video, platform, error)
            if all(p["state"] == "published" for p in self.store.publications(video["id"])):
                self.store.event("info", "Video published on Instagram and YouTube.", video["id"])
                if verify:
                    self.store.settings_patch({"integrations_verified": True})

    def publish_guarded(self, video, pub, verify, partial):
        self.check()
        settings = self.store.settings()
        # Hour spacing was checked for the PAIR before dispatch. One platform's
        # just-confirmed publication must not block the other member of this pair.
        if (settings["paused"] and not verify) or not settings["youtube_audit_confirmed"] or not eligible_time(now(), settings, partial=True):
            return
        def before_publish():
            latest = self.store.settings()
            latest["last_publication_at"] = self.store.latest_other_publication(video["id"])
            if (latest["paused"] and not verify) or not latest["youtube_audit_confirmed"] or not eligible_time(now(), latest):
                raise RelayError("posting_paused_or_window_closed")
        self.providers[pub["platform"]].before_publish = before_publish
        self.providers[pub["platform"]].publish(video, pub)

    def tick(self, verify_id=None):
        if not self.store.acquire():
            return "Another worker is active"
        try:
            self.store.settings_patch({"worker_seen_at": now().isoformat()})
            settings = self.store.settings()
            if not self.discover(settings):
                return "Waiting for a complete history import"
            settings = self.store.settings()
            if verify_id:
                if not verify_id.isdigit():
                    raise RelayError("invalid_test_video", permanent=True)
                video = self.store.video(verify_id)
                if not video:
                    raise RelayError("test_video_not_in_source_account", permanent=True)
            elif settings["paused"] or not settings["integrations_verified"] or not settings["youtube_audit_confirmed"]:
                return "Import updated; publishing paused until setup is complete"
            else:
                video = self.store.head()
            if video:
                self.process(video, verify=bool(verify_id))
                # Invalid items should not delay the next eligible video by a full tick.
                if not verify_id:
                    for _ in range(49):
                        if self.store.video(video["id"])["state"] != "skipped":
                            break
                        self.check()
                        video = self.store.head()
                        if not video:
                            break
                        self.process(video)
            return "Worker check completed"
        except BudgetReached:
            self.store.event("info", "Worker time budget reached; work will resume on the next check.")
            return "Time budget reached safely"
        except RelayError as error:
            self.store.settings_patch({"worker_error": error.code})
            return "Worker requires attention: " + error.code
        finally:
            self.store.settings_patch({"worker_seen_at": now().isoformat()})
            self.store.release()
