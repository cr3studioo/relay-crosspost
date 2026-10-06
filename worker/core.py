"""Pure scheduling, eligibility, metadata, and shared encryption helpers."""
import base64
import json
import os
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc


class RelayError(Exception):
    def __init__(self, code, permanent=False, uncertain=False, detail=None):
        self.code, self.permanent, self.uncertain = code, permanent, uncertain
        self.detail = detail
        super().__init__(code)


class BudgetReached(Exception):
    pass


def now():
    return datetime.now(UTC)


def parse_date(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def in_window(instant, settings):
    hour = instant.astimezone(ZoneInfo(settings["timezone"])).hour
    return settings["start_hour"] <= hour < settings["end_hour"]


def eligible_time(instant, settings, partial=False):
    if not in_window(instant, settings):
        return False
    last = parse_date(settings.get("last_publication_at"))
    return partial or not last or instant >= last + timedelta(hours=1)


def retry_delay(attempt):
    return timedelta(minutes=(15, 30, 60)[min(max(attempt - 1, 0), 2)])


def first_line(caption, video_id):
    return next((line.strip() for line in caption.splitlines() if line.strip()), f"Video {video_id}")


def render(template, video):
    replacements = {"caption": video["caption"], "first_line": first_line(video["caption"], video["id"]),
                    "source_url": video["source_url"], "video_id": video["id"]}
    return re.sub(r"\{(caption|first_line|source_url|video_id)\}", lambda match: replacements[match[1]], template)


def metadata(settings, video, platform):
    if platform == "instagram":
        caption = render(settings["instagram_template"], video)
        if len(caption) > 2200:
            raise RelayError("caption_too_long", permanent=True)
        return {"caption": caption}
    title = render(settings["youtube_title_template"], video).replace("<", "").replace(">", "").strip()[:100]
    description = render(settings["youtube_description_template"], video)
    if len(description.encode("utf-8")) > 5000:
        raise RelayError("description_too_long", permanent=True)
    return {"title": title or f"Video {video['id']}", "description": description,
            "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False}


def eligibility(info):
    if not info.get("duration") or not info.get("width") or not info.get("height"):
        return "Photo post or missing video metadata"
    if not 3 <= info["duration"] <= 180:
        return "Video must be between 3 seconds and 3 minutes"
    if info["width"] > info["height"]:
        return "Horizontal video; only square or vertical videos are supported"
    if info["width"] > 1920:
        return "Video exceeds Instagram's horizontal resolution limit"
    if info.get("size", 0) > 300 * 1024 * 1024:
        return "Video exceeds the conservative 300 MB upload limit"
    if info.get("video_codec") not in (None, "h264", "hevc"):
        return "Unsupported video codec; no conversion is configured"
    if info.get("audio_codec") not in (None, "aac"):
        return "Unsupported audio codec; no audio changes are configured"
    if info.get("fps") is not None and not 23 <= info["fps"] <= 60:
        return "Frame rate is outside Instagram's supported range"
    if info.get("video_bitrate", 0) > 25_000_000:
        return "Video bitrate exceeds Instagram's limit"
    return None


def watermark_free_format(formats):
    # Choose a playback/direct source, never assume an unknown download is clean.
    safe = [f for f in formats if f.get("url") and f.get("vcodec") != "none" and f.get("acodec") != "none"
            and "watermark" not in str(f.get("format_note", "")).lower()
            and (str(f.get("format_note", "")).lower() in ("direct video", "playback video")
                 or str(f.get("format_id", "")).startswith(("h264", "bytevc1", "play_addr"))
                 or f.get("format_id") == "play")]
    return max(safe, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0), default=None)


def seal(value, key_hex):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = bytes.fromhex(key_hex)
    if len(key) != 32:
        raise ValueError("Encryption key must be 32 bytes")
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), b"relay-v1")
    return "v1." + base64.urlsafe_b64encode(nonce + ciphertext).decode().rstrip("=")


def unseal(value, key_hex):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not value.startswith("v1."):
        raise ValueError("Invalid encrypted payload")
    payload = value[3:]
    raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
    return json.loads(AESGCM(bytes.fromhex(key_hex)).decrypt(raw[:12], raw[12:], b"relay-v1"))
