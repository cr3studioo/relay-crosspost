"""Official platform clients. Exceptions contain fixed codes, never API responses."""
import hashlib
import os
from datetime import timedelta
from urllib.parse import urlparse
import requests
from .core import RelayError, now, parse_date, seal, unseal


def api(method, url, **kwargs):
    try:
        response = requests.request(method, url, timeout=(10, 120), **kwargs)
    except requests.RequestException:
        raise RelayError("platform_network_error", uncertain=True) from None
    if response.status_code in (200, 201, 204, 308):
        return response
    code = "platform_request_failed"
    permanent = response.status_code in (400, 401, 403, 404)
    try:
        error = response.json().get("error", {})
        if isinstance(error, str):
            if error in ("invalid_grant", "invalid_token"):
                raise RelayError("authorization_revoked", permanent=True)
            error = {}
        reasons = {e.get("reason") for e in error.get("errors", [])}
        if response.status_code == 429 or reasons & {"quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded", "uploadLimitExceeded"} or error.get("is_transient"):
            code, permanent = "platform_rate_or_quota_limit", False
        elif response.status_code == 401 or error.get("code") == 190:
            code, permanent = "authorization_expired", True
    except (ValueError, AttributeError):
        pass
    raise RelayError(code, permanent=permanent, uncertain=response.status_code >= 500)


class Provider:
    def __init__(self, store):
        self.store = store
        self.before_publish = lambda: None

    def credentials(self):
        record, token = self.store.credentials(self.platform)
        expiry = parse_date(token.get("expires_at"))
        if self.platform == "youtube" and (not expiry or expiry < now() + timedelta(minutes=5)):
            try:
                response = api("POST", "https://oauth2.googleapis.com/token", data={
                    "grant_type": "refresh_token", "client_id": os.environ["GOOGLE_CLIENT_ID"],
                    "client_secret": os.environ["GOOGLE_CLIENT_SECRET"], "refresh_token": token["refresh_token"]}).json()
            except RelayError as error:
                if error.code == "authorization_revoked":
                    self.store.clear_youtube_data()
                raise
            token.update(access_token=response["access_token"], expires_at=(now() + timedelta(seconds=response["expires_in"])).isoformat())
            self.store.save_credentials(self.platform, token)
        elif self.platform == "instagram" and expiry and expiry <= now():
            raise RelayError("authorization_expired", permanent=True)
        return record["account_id"], token["access_token"]

    def patch(self, video, **values):
        self.store.publication_patch(video["id"], self.platform, values)

    def confirmed(self, video, external_id, url):
        self.patch(video, state="published", external_id=external_id, public_url=url,
                   published_at=now().isoformat(), confirmation_origin="relay_api", error_code=None, next_retry_at=None, resume_state=None, encrypted_session=None)


class Instagram(Provider):
    platform = "instagram"

    @property
    def base(self):
        return "https://graph.facebook.com/" + os.getenv("META_GRAPH_VERSION", "v25.0")

    def status(self, container, token):
        return api("GET", self.base + "/" + container, params={"fields": "status_code"},
                   headers={"Authorization": f"Bearer {token}"}).json()["status_code"]

    def prepare(self, video, pub, path, metadata):
        account_id, token = self.credentials()
        container = pub.get("external_id")
        if container:
            status = self.status(container, token)
            if status == "FINISHED":
                self.patch(video, state="ready")
                return
            if status == "PUBLISHED":
                raise RelayError("published_id_needs_reconciliation", permanent=True, uncertain=True)
            if status == "ERROR":
                raise RelayError("instagram_processing_rejected", permanent=True)
            if status == "IN_PROGRESS" and pub["state"] != "uploading":
                return
            if status == "EXPIRED":
                self.patch(video, state="pending", external_id=None, encrypted_session=None)
                return
        if not container:
            self.store.heartbeat()
            created = api("POST", self.base + "/" + account_id + "/media", headers={"Authorization": f"Bearer {token}"},
                          data={"media_type": "REELS", "upload_type": "resumable", "caption": metadata["caption"], "share_to_feed": "true"}).json()
            container = created["id"]
            uri = created["uri"]
            if urlparse(uri).scheme != "https" or urlparse(uri).hostname != "rupload.facebook.com":
                raise RelayError("invalid_upload_host", permanent=True)
            self.patch(video, state="uploading", external_id=container,
                       encrypted_session=seal({"uri": uri}, self.store.key), rendered_metadata=metadata)
        else:
            uri = unseal(pub["encrypted_session"], self.store.key)["uri"]
        self.store.heartbeat()
        try:
            with path.open("rb") as file:
                api("POST", uri, headers={"Authorization": f"OAuth {token}", "offset": "0", "file_size": str(path.stat().st_size),
                                          "Content-Type": "application/octet-stream"}, data=file)
        except RelayError as error:
            if error.uncertain:
                # Stay on the existing container; inspect processing before any retry.
                self.patch(video, state="processing")
            raise
        self.patch(video, state="processing")

    def reconcile(self, video, pub):
        if not pub.get("external_id"):
            raise RelayError("missing_publish_identifier", permanent=True, uncertain=True)
        account_id, token = self.credentials()
        status = self.status(pub["external_id"], token)
        if status == "PUBLISHED":
            # A lost media_publish response doesn't provide the public media ID.
            # Safe attention state: never blindly create another published copy.
            raise RelayError("published_id_needs_reconciliation", permanent=True, uncertain=True)
        if status in ("FINISHED", "IN_PROGRESS"):
            # After a publish timeout, FINISHED can race the server. Do NOT republish.
            raise RelayError("publication_outcome_unknown", permanent=True, uncertain=True)
        raise RelayError("instagram_publication_rejected", permanent=True, uncertain=True)

    def publish(self, video, pub):
        account_id, token = self.credentials()
        if self.status(pub["external_id"], token) != "FINISHED":
            raise RelayError("instagram_not_ready")
        self.store.heartbeat()
        self.patch(video, state="publishing", resume_state="publishing")
        try:
            self.before_publish()
            result = api("POST", self.base + "/" + account_id + "/media_publish",
                         headers={"Authorization": f"Bearer {token}"}, data={"creation_id": pub["external_id"]}).json()
        except RelayError as error:
            if not error.uncertain:
                self.patch(video, state="ready", resume_state="ready")
            raise
        media_id = result["id"]
        # Preserve the acknowledged ID BEFORE the optional permalink lookup.
        self.confirmed(video, media_id, None)
        try:
            media = api("GET", self.base + "/" + media_id, params={"fields": "permalink"}, headers={"Authorization": f"Bearer {token}"}).json()
            self.patch(video, public_url=media.get("permalink"))
        except RelayError:
            pass


class YouTube(Provider):
    platform = "youtube"

    def target(self):
        return self.store.settings().get("youtube_visibility", "public")

    def confirm_target(self, video, external_id, visibility):
        url = "https://www.youtube.com/shorts/" + external_id if visibility in ("public", "unlisted") else None
        self.confirmed(video, external_id, url)
        self.store.refresh_youtube_publication(video["id"], visibility)

    def maintain(self, accepted):
        """Check revocation even while paused; refresh references or expire them."""
        try:
            settings = self.store.settings()
            records = self.store.request("GET", "credentials", params={"platform": "eq.youtube"})
            if not records:
                return
            record = records[0]
            if settings.get("youtube_revoke_requested_at"):
                try:
                    token = unseal(record["encrypted_payload"], self.store.key)
                except Exception:
                    raise RelayError("credential_decryption_failed", permanent=True) from None
                try:
                    api("POST", "https://oauth2.googleapis.com/revoke", data={"token": token.get("refresh_token") or token["access_token"]})
                except RelayError as error:
                    if error.code != "authorization_revoked":
                        raise
                self.store.clear_youtube_data()
                return
            # Refreshing tokens discovers invalid_grant; network failures do not
            # count as proof of revocation and must not erase healthy credentials.
            account, token = self.credentials()
            if not accepted:
                return
            week_ago = now() - timedelta(days=7)
            if parse_date(record.get("api_checked_at")) is None or parse_date(record["api_checked_at"]) < week_ago:
                channel = api("GET", "https://www.googleapis.com/youtube/v3/channels", params={"part": "snippet", "mine": "true"},
                    headers={"Authorization": f"Bearer {token}"}).json().get("items", [])
                if len(channel) != 1 or channel[0]["id"] != account:
                    raise RelayError("youtube_channel_mismatch", permanent=True)
                self.store.heartbeat()
                self.store.request("PATCH", "credentials", params={"platform": "eq.youtube"},
                    json={"account_label": channel[0]["snippet"]["title"], "api_checked_at": now().isoformat()})
            # Bounded batches keep a large historical account within the worker's
            # time budget. Missing videos lose their API references, never reupload.
            rows = self.store.stale_youtube_publications(week_ago.isoformat())
            if rows:
                result = api("GET", "https://www.googleapis.com/youtube/v3/videos", params={"part": "status", "id": ",".join(p["external_id"] for p in rows)},
                    headers={"Authorization": f"Bearer {token}"}).json()
                found = {item["id"]: item["status"]["privacyStatus"] for item in result.get("items", [])}
                for pub in rows:
                    if pub["external_id"] in found:
                        self.store.refresh_youtube_publication(pub["video_id"], found[pub["external_id"]])
                    else:
                        self.store.publication_patch(pub["video_id"], self.platform, {"public_url": None})
                        # Leave the old refresh timestamp so expiry removes the
                        # missing reference by day 30 and blocks uncertain retries.
        finally:
            self.store.expire_youtube_data()

    def video_status(self, video_id, token):
        result = api("GET", "https://www.googleapis.com/youtube/v3/videos", params={"part": "status,processingDetails", "id": video_id},
                     headers={"Authorization": f"Bearer {token}"}).json()
        if not result.get("items"):
            raise RelayError("youtube_video_missing", permanent=True)
        return result["items"][0]

    def prepare(self, video, pub, path, metadata):
        _account, token = self.credentials()
        if pub.get("external_id"):
            status = self.video_status(pub["external_id"], token)
            if status["status"].get("uploadStatus") in ("rejected", "failed", "deleted") or status.get("processingDetails", {}).get("processingStatus") in ("failed", "terminated"):
                raise RelayError("youtube_processing_rejected", permanent=True)
            self.store.refresh_youtube_publication(video["id"], status["status"]["privacyStatus"])
            # A user may change visibility in Studio. Observing that change is
            # not proof that Relay's publication request succeeded.
            if status.get("processingDetails", {}).get("processingStatus") == "succeeded":
                self.patch(video, state="ready")
            return
        size = path.stat().st_size
        with path.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        session = unseal(pub["encrypted_session"], self.store.key) if pub.get("encrypted_session") else None
        if session and (session["size"] != size or session["sha256"] != digest):
            raise RelayError("source_changed_during_upload", permanent=True)
        if not session:
            self.store.heartbeat()
            created = api("POST", "https://www.googleapis.com/upload/youtube/v3/videos", params={"uploadType": "resumable", "part": "snippet,status", "notifySubscribers": "false"},
                          headers={"Authorization": f"Bearer {token}", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)},
                          json={"snippet": {"title": metadata["title"], "description": metadata["description"], "categoryId": "22"},
                                "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False}})
            uri = created.headers.get("Location", "")
            if urlparse(uri).scheme != "https" or urlparse(uri).hostname != "www.googleapis.com":
                raise RelayError("invalid_upload_host", permanent=True)
            session = {"uri": uri, "size": size, "sha256": digest}
            self.patch(video, state="uploading", encrypted_session=seal(session, self.store.key), rendered_metadata=metadata)
        self.store.heartbeat()
        # Query offset before resuming, including after a lost final upload response.
        response = api("PUT", session["uri"], headers={"Authorization": f"Bearer {token}", "Content-Length": "0", "Content-Range": f"bytes */{size}"}, data=b"")
        if response.status_code in (200, 201):
            result = response.json()
        else:
            offset = int(response.headers.get("Range", "bytes=0--1").split("-")[-1]) + 1 if "Range" in response.headers else 0
            with path.open("rb") as file:
                file.seek(offset)
                response = api("PUT", session["uri"], headers={"Authorization": f"Bearer {token}", "Content-Type": "video/mp4",
                               "Content-Length": str(size - offset), "Content-Range": f"bytes {offset}-{size - 1}/{size}"}, data=file)
            if response.status_code == 308:
                return
            result = response.json()
        self.patch(video, external_id=result["id"], state="processing", encrypted_session=None)

    def reconcile(self, video, pub):
        _account, token = self.credentials()
        result = self.video_status(pub["external_id"], token)
        if result["status"]["privacyStatus"] == self.target():
            self.confirm_target(video, pub["external_id"], self.target())
        else:
            # Repeating a privacy update for this known video cannot create duplicates.
            self.patch(video, state="ready", resume_state="ready")

    def publish(self, video, pub):
        _account, token = self.credentials()
        target = self.target()
        self.store.heartbeat()
        self.patch(video, state="publishing", resume_state="publishing")
        try:
            self.before_publish()
            api("PUT", "https://www.googleapis.com/youtube/v3/videos", params={"part": "status"},
                headers={"Authorization": f"Bearer {token}"}, json={"id": pub["external_id"], "status": {"privacyStatus": target, "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False}})
        except RelayError as error:
            if not error.uncertain:
                self.patch(video, state="ready", resume_state="ready")
            raise
        status = self.video_status(pub["external_id"], token)
        if status["status"]["privacyStatus"] != target:
            raise RelayError("youtube_publication_restricted", permanent=True)
        self.confirm_target(video, pub["external_id"], target)
