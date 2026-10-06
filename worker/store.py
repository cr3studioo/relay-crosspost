import os
import uuid
import requests
from .core import RelayError, seal, unseal


class Store:
    def __init__(self):
        self.base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
        secret = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.headers = {"apikey": secret, "Authorization": f"Bearer {secret}"}
        self.key = os.environ["TOKEN_ENCRYPTION_KEY"]
        self.holder = str(uuid.uuid4())

    def request(self, method, path, **kwargs):
        try:
            response = requests.request(method, self.base + path, headers=self.headers, timeout=(10, 30), **kwargs)
            if not response.ok:
                raise RelayError("database_request_failed", permanent=response.status_code in (401, 403))
            return response.json() if response.content else None
        except requests.RequestException:
            raise RelayError("database_unavailable") from None

    def rpc(self, name, **kwargs):
        return self.request("POST", "rpc/" + name, json={"p_holder": self.holder, **kwargs})

    def acquire(self):
        return self.rpc("acquire_lease")

    def heartbeat(self):
        self.rpc("assert_lease")

    def release(self):
        self.rpc("release_lease")

    def settings(self):
        return self.request("GET", "settings", params={"select": "*"})[0]

    def settings_patch(self, patch):
        self.rpc("worker_settings", p_patch=patch)

    def ingest(self, video):
        self.rpc("ingest_video", p_video=video)

    def known_ids(self):
        result = set()
        offset = 0
        while True:
            rows = self.request("GET", "videos", params={"select": "id", "order": "id.asc", "limit": "1000", "offset": str(offset)})
            result.update(row["id"] for row in rows)
            if len(rows) < 1000:
                return result
            offset += 1000

    def video(self, video_id):
        rows = self.request("GET", "videos", params={"id": f"eq.{video_id}", "select": "*"})
        return rows[0] if rows else None

    def head(self):
        rows = self.request("GET", "videos", params={"state": "not.in.(published,skipped)", "order": "source_created_at.asc,id.asc", "limit": "1"})
        return rows[0] if rows else None

    def video_patch(self, video_id, state, reason=None):
        self.rpc("update_video", p_id=video_id, p_state=state, p_reason=reason)

    def publications(self, video_id):
        return self.request("GET", "publications", params={"video_id": f"eq.{video_id}", "order": "platform.asc"})

    def latest_other_publication(self, video_id):
        rows = self.request("GET", "publications", params={"select": "published_at", "video_id": f"neq.{video_id}",
                            "state": "eq.published", "published_at": "not.is.null", "order": "published_at.desc", "limit": "1"})
        return rows[0]["published_at"] if rows else None

    def publication_patch(self, video_id, platform, patch):
        self.rpc("update_publication", p_id=video_id, p_platform=platform, p_patch=patch)

    def credentials(self, platform):
        rows = self.request("GET", "credentials", params={"platform": f"eq.{platform}"})
        if not rows or not rows[0]["account_id"]:
            raise RelayError("account_not_connected", permanent=True)
        record = rows[0]
        try:
            payload = unseal(record["encrypted_payload"], self.key)
        except Exception:
            raise RelayError("credential_decryption_failed", permanent=True) from None
        return record, payload

    def save_credentials(self, platform, payload):
        self.heartbeat()
        self.request("PATCH", "credentials", params={"platform": f"eq.{platform}"}, json={"encrypted_payload": seal(payload, self.key)})

    def event(self, level, message, video_id=None):
        self.rpc("worker_event", p_level=level, p_message=message, p_video_id=video_id)
