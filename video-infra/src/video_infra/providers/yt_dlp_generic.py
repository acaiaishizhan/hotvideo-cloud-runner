from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable, ContextManager
from urllib.parse import urlparse

import yt_dlp

from ..schema import Author, Media, Stats, VideoResult
from ..storage.paths import safe_name
from .base import VideoProvider


OptionsContext = Callable[[str], ContextManager[dict[str, Any]]]


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

    def __init__(self, options_context: OptionsContext | None = None):
        self._options_context = options_context or (lambda _url: nullcontext({}))

    def supports(self, url: str) -> bool:
        return url.startswith("http://") or url.startswith("https://")

    @staticmethod
    def _is_youtube(url: str) -> bool:
        host = (urlparse(url).hostname or "").lower()
        return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")

    @classmethod
    def option_candidates(cls, url: str, extra: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        base = dict(extra or {})
        candidates = [base]
        if cls._is_youtube(url):
            candidates.append({
                **base,
                "extractor_args": {"youtube": {"player_client": ["android_vr"]}},
            })
        return candidates

    @classmethod
    def should_try_next_candidate(cls, url: str, error: Exception) -> bool:
        if not cls._is_youtube(url):
            return False
        message = str(error).lower()
        return any(marker in message for marker in (
            "http error 403",
            "sign in to confirm",
            "page needs to be reloaded",
        ))

    @staticmethod
    def _result_from_info(info: dict[str, Any], url: str) -> VideoResult:
        requested = info.get("requested_formats") or []
        direct_url = info.get("url") or (requested[0].get("url") if requested else "")
        platform = _platform(info)

        return VideoResult(
            platform=platform,
            provider=YtDlpGenericProvider.name,
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

    def _extract(self, url: str, *, download: bool, common_opts: dict[str, Any]) -> tuple[dict[str, Any], Path | None]:
        last_error: Exception | None = None
        with self._options_context(url) as extra_opts:
            candidates = self.option_candidates(url, extra_opts)
            for index, candidate in enumerate(candidates):
                opts = {**common_opts, **candidate}
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(url, download=download)
                        prepared = Path(ydl.prepare_filename(info)) if download else None
                    if not info:
                        raise ValueError("yt-dlp did not return video info")
                    return info, prepared
                except Exception as exc:
                    last_error = exc
                    if index + 1 >= len(candidates) or not self.should_try_next_candidate(url, exc):
                        raise
        if last_error:
            raise last_error
        raise ValueError("yt-dlp did not return video info")

    def parse(self, url: str) -> VideoResult:
        info, _ = self._extract(url, download=False, common_opts={
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
            "extract_flat": False,
            "noplaylist": True,
        })
        return self._result_from_info(info, url)

    def download(self, url: str, output_dir: Path | None = None, format_id: str | None = None) -> VideoResult:
        target_dir = output_dir or Path.cwd()
        target_dir.mkdir(parents=True, exist_ok=True)

        fmt = format_id or "bestvideo+bestaudio/best"
        info, prepared = self._extract(url, download=True, common_opts={
            "format": fmt,
            "outtmpl": str(target_dir / "%(title).90B.%(ext)s"),
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
            "noplaylist": True,
            "merge_output_format": "mp4",
        })
        parsed = self._result_from_info(info, url)

        candidates = []
        if prepared and prepared.exists():
            candidates.append(prepared)
        candidates.extend(sorted(target_dir.glob(f"{safe_name(parsed.title, parsed.id)}*"), key=lambda p: p.stat().st_mtime, reverse=True))
        if not candidates:
            candidates.extend(sorted(target_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True))
        if candidates:
            parsed.files.videoPath = str(candidates[0])
        return parsed
