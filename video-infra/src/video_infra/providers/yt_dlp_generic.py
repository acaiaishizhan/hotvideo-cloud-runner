from __future__ import annotations

from pathlib import Path
from typing import Any

import yt_dlp

from ..schema import Author, Media, Stats, VideoResult
from ..storage.paths import safe_name
from .base import VideoProvider


def _date(value: str | None) -> str | None:
    if not value or len(value) != 8:
        return None
    return f"{value[0:4]}-{value[4:6]}-{value[6:8]}"


def _platform(info: dict[str, Any]) -> str:
    key = (info.get("extractor_key") or info.get("extractor") or "unknown").lower()
    if "youtube" in key:
        return "youtube"
    if "tiktok" in key:
        return "tiktok"
    if "bilibili" in key or key == "biliintl":
        return "bilibili"
    return key or "unknown"


def _formats(info: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in info.get("formats") or []:
        has_video = item.get("vcodec") not in (None, "none")
        if not has_video:
            continue
        rows.append({
            "formatId": item.get("format_id", ""),
            "ext": item.get("ext", ""),
            "width": item.get("width"),
            "height": item.get("height"),
            "resolution": item.get("resolution") or (
                f"{item.get('width')}x{item.get('height')}" if item.get("width") and item.get("height") else ""
            ),
            "filesize": item.get("filesize") or item.get("filesize_approx"),
            "vcodec": item.get("vcodec"),
            "acodec": item.get("acodec"),
            "hasAudio": item.get("acodec") not in (None, "none"),
            "url": item.get("url", ""),
        })
    rows.sort(key=lambda x: x.get("height") or 0, reverse=True)
    return rows[:20]


def _subtitles(info: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for kind, bucket in (("manual", info.get("subtitles") or {}), ("automatic", info.get("automatic_captions") or {})):
        for lang, entries in bucket.items():
            out.append({
                "language": lang,
                "kind": kind,
                "formats": [{"ext": e.get("ext"), "url": e.get("url", "")} for e in entries[:5]],
            })
    return out[:30]


class YtDlpGenericProvider(VideoProvider):
    name = "yt-dlp"
    platform = "generic"

    def supports(self, url: str) -> bool:
        return url.startswith("http://") or url.startswith("https://")

    def parse(self, url: str) -> VideoResult:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "noplaylist": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if not info:
            raise ValueError("yt-dlp did not return video info")

        requested = info.get("requested_formats") or []
        direct_url = info.get("url") or (requested[0].get("url") if requested else "")
        platform = _platform(info)

        return VideoResult(
            platform=platform,
            provider=self.name,
            id=str(info.get("id") or ""),
            canonicalUrl=info.get("webpage_url") or url,
            sourceUrl=url,
            title=info.get("title") or "",
            description=info.get("description") or "",
            author=Author(
                id=str(info.get("channel_id") or info.get("uploader_id") or ""),
                name=info.get("uploader") or info.get("channel") or "",
                avatarUrl=info.get("uploader_avatar") or "",
                profileUrl=info.get("channel_url") or info.get("uploader_url") or "",
                followerCount=info.get("channel_follower_count"),
            ),
            durationSec=info.get("duration"),
            publishedAt=_date(info.get("upload_date")),
            thumbnailUrl=info.get("thumbnail") or "",
            stats=Stats(
                viewCount=info.get("view_count"),
                likeCount=info.get("like_count"),
                commentCount=info.get("comment_count"),
                repostCount=info.get("repost_count"),
            ),
            media=Media(formats=_formats(info), directUrl=direct_url),
            subtitles=_subtitles(info),
            raw={"extractor": info.get("extractor"), "extractor_key": info.get("extractor_key")},
        )

    def download(self, url: str, output_dir: Path | None = None, format_id: str | None = None) -> VideoResult:
        parsed = self.parse(url)
        target_dir = output_dir or Path.cwd()
        target_dir.mkdir(parents=True, exist_ok=True)

        fmt = format_id or "bestvideo+bestaudio/best"
        opts = {
            "format": fmt,
            "outtmpl": str(target_dir / "%(title).90B.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "merge_output_format": "mp4",
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            prepared = Path(ydl.prepare_filename(info))

        candidates = []
        if prepared.exists():
            candidates.append(prepared)
        candidates.extend(sorted(target_dir.glob(f"{safe_name(parsed.title, parsed.id)}*"), key=lambda p: p.stat().st_mtime, reverse=True))
        if not candidates:
            candidates.extend(sorted(target_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True))
        if candidates:
            parsed.files.videoPath = str(candidates[0])
        return parsed
