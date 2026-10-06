import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from .core import UTC, RelayError, eligibility, watermark_free_format


class QuietLogger:
    def debug(self, _message): pass
    def info(self, _message): pass
    def warning(self, _message): pass
    def error(self, _message): pass


class Source:
    def __init__(self, check=lambda: None):
        self.check = check

    def options(self, **extra):
        return {"quiet": True, "no_warnings": True, "logger": QuietLogger(), "socket_timeout": 30,
                "retries": 2, "extractor_retries": 2, "noprogress": True, **extra}

    def list(self, profile):
        import yt_dlp
        if not re.fullmatch(r"https://www\.tiktok\.com/@[\w.]{2,24}", profile):
            raise RelayError("invalid_profile", permanent=True)
        channel_id = os.environ.get("TIKTOK_CHANNEL_ID", "")
        use_hint = bool(channel_id and os.environ.get("TIKTOK_PROFILE_URL") == profile)
        if use_hint and not re.fullmatch(r"MS4w[A-Za-z0-9_-]{10,180}", channel_id):
            raise RelayError("invalid_source_hint", permanent=True)
        lookup = "tiktokuser:" + channel_id if use_hint else profile
        try:
            with yt_dlp.YoutubeDL(self.options(extract_flat=True, lazy_playlist=True)) as ydl:
                info = ydl.extract_info(lookup, download=False)
                for entry in info.get("entries", []):
                    self.check()
                    if not entry or not entry.get("id") or not entry.get("timestamp"):
                        raise RelayError("incomplete_history_metadata")
                    # An account-ID hint must never import another account's posts.
                    if use_hint and (entry.get("uploader_url") or "").rstrip("/").lower() != profile.lower():
                        raise RelayError("source_account_mismatch", permanent=True)
                    yield {"id": entry["id"], "source_url": profile + "/video/" + entry["id"],
                           "source_created_at": datetime.fromtimestamp(entry["timestamp"], UTC).isoformat(),
                           "caption": entry.get("description") or "", "duration": entry.get("duration"),
                           "width": entry.get("width"), "height": entry.get("height")}
        except yt_dlp.utils.DownloadError:
            raise RelayError("tiktok_listing_failed") from None

    def download(self, video, folder):
        import yt_dlp
        self.check()
        try:
            with yt_dlp.YoutubeDL(self.options()) as ydl:
                info = ydl.extract_info(video["source_url"], download=False)
                if not info or not info.get("formats"):
                    raise RelayError("no_video_source", permanent=True)
                selected = watermark_free_format(info["formats"])
                if not selected:
                    raise RelayError("no_watermark_free_source", permanent=True)
                path = Path(folder) / "source.mp4"
                def progress(_status): self.check()
                with yt_dlp.YoutubeDL(self.options(format=selected["format_id"], outtmpl=str(path),
                                                   progress_hooks=[progress], max_filesize=300 * 1024 * 1024)) as download:
                    download.process_ie_result(info, download=True)
                if not path.exists():
                    raise RelayError("no_video_source", permanent=True)
        except yt_dlp.utils.DownloadError:
            raise RelayError("tiktok_download_failed") from None
        self.check()
        try:
            result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                                    capture_output=True, text=True, timeout=30, check=True)
            probe = json.loads(result.stdout)
            stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
            audio = next((s for s in probe["streams"] if s["codec_type"] == "audio"), {})
            num, den = map(int, stream.get("avg_frame_rate", "0/1").split("/"))
            validated = {"duration": float(probe["format"]["duration"]), "width": stream["width"], "height": stream["height"],
                         "size": path.stat().st_size, "video_codec": stream.get("codec_name"), "audio_codec": audio.get("codec_name"),
                         "fps": num / den if den else 0, "video_bitrate": int(stream.get("bit_rate", 0))}
        except (subprocess.SubprocessError, KeyError, ValueError, StopIteration):
            raise RelayError("invalid_media", permanent=True) from None
        reason = eligibility(validated)
        if reason:
            raise RelayError("ineligible_media", permanent=True, detail=reason)
        return path, validated
