from __future__ import annotations

from pathlib import Path
from typing import Any

import requests

from ..schema import Author, Files, Media, Stats, VideoResult

MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
MIN_VIDEO_BYTES = 1024
_MP4_PREFIX_LIMIT = 64 * 1024
_METADATA_FIELDS = {
    "id", "platform", "canonicalUrl", "title", "description", "author",
    "durationSec", "publishedAt", "thumbnailUrl", "stats",
}
_AUTHOR_FIELDS = {"id", "name", "avatarUrl", "profileUrl", "followerCount"}
_STATS_FIELDS = {"viewCount", "likeCount", "commentCount", "shareCount", "favoriteCount", "repostCount"}


def _integer(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"metadata.{field} 必须是整数")
    if isinstance(value, int):
        return value
    if not isinstance(value, str):
        raise ValueError(f"metadata.{field} 必须是整数")
    try:
        number = int(value)
    except ValueError as exc:
        raise ValueError(f"metadata.{field} 必须是整数") from exc
    if value.strip() not in {str(number), f"+{number}"}:
        raise ValueError(f"metadata.{field} 必须是整数")
    return number


def _object(value: Any, field: str, allowed: set[str]) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"metadata.{field} 必须是对象")
    unexpected = set(value) - allowed
    if unexpected:
        raise ValueError(f"metadata.{field} 包含不支持字段: {', '.join(sorted(unexpected))}")
    return value


def _video_result(media_url: str, metadata: dict[str, Any], target: Path) -> VideoResult:
    if not isinstance(metadata, dict):
        raise ValueError("metadata 必须是对象")
    unexpected = set(metadata) - _METADATA_FIELDS
    if unexpected:
        raise ValueError(f"metadata 包含不支持字段: {', '.join(sorted(unexpected))}")
    author_data = _object(metadata.get("author"), "author", _AUTHOR_FIELDS)
    stats_data = _object(metadata.get("stats"), "stats", _STATS_FIELDS)
    return VideoResult(
        platform=str(metadata.get("platform") or "unknown"),
        provider="direct-media",
        id=str(metadata.get("id") or ""),
        canonicalUrl=str(metadata.get("canonicalUrl") or ""),
        sourceUrl=media_url,
        title=str(metadata.get("title") or ""),
        description=str(metadata.get("description") or ""),
        author=Author(
            id=str(author_data.get("id") or ""),
            name=str(author_data.get("name") or ""),
            avatarUrl=str(author_data.get("avatarUrl") or ""),
            profileUrl=str(author_data.get("profileUrl") or ""),
            followerCount=_integer(author_data.get("followerCount"), "author.followerCount"),
        ),
        durationSec=_integer(metadata.get("durationSec"), "durationSec"),
        publishedAt=str(metadata.get("publishedAt")) if metadata.get("publishedAt") is not None else None,
        thumbnailUrl=str(metadata.get("thumbnailUrl") or ""),
        stats=Stats(**{key: _integer(value, f"stats.{key}") for key, value in stats_data.items()}),
        media=Media(directUrl=media_url),
        files=Files(videoPath=str(target)),
    )


def _is_supported_video(prefix: bytes) -> bool:
    if prefix.startswith(b"\x1a\x45\xdf\xa3"):
        return True
    offset = 0
    limit = min(len(prefix), _MP4_PREFIX_LIMIT)
    while offset + 8 <= limit:
        size = int.from_bytes(prefix[offset:offset + 4], "big")
        box_type = prefix[offset + 4:offset + 8]
        if box_type == b"ftyp":
            return True
        if box_type not in {b"free", b"skip"} or size < 8:
            return False
        if size == 1:
            if offset + 16 > limit:
                return False
            size = int.from_bytes(prefix[offset + 8:offset + 16], "big")
        if size <= 0 or offset + size > limit:
            return False
        offset += size
    return False


def download_direct_video(
    url: str,
    output_dir: str | Path,
    metadata: dict[str, Any],
    *,
    get=requests.get,
) -> VideoResult:
    """Download an already-resolved public media URL without platform parsing."""
    if not str(url).startswith(("https://", "http://")):
        raise ValueError("缺少有效直链地址")
    directory = Path(output_dir).resolve()
    target = directory / "video.mp4"
    temporary = target.with_suffix(".mp4.part")
    result = _video_result(url, metadata, target)
    directory.mkdir(parents=True, exist_ok=True)
    temporary.unlink(missing_ok=True)
    response = None
    try:
        response = get(url, stream=True, timeout=(10, 60), allow_redirects=True)
        response.raise_for_status()
        content_type = str(getattr(response, "headers", {}).get("Content-Type", "")).lower()
        if "text/html" in content_type or "application/json" in content_type:
            raise ValueError(f"直链响应不是视频: Content-Type={content_type}")
        content_length = getattr(response, "headers", {}).get("Content-Length")
        if content_length and int(content_length) > MAX_VIDEO_BYTES:
            raise ValueError("视频超过 2 GiB")
        total = 0
        prefix = bytearray()
        with temporary.open("wb") as file:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_VIDEO_BYTES:
                    raise ValueError("视频超过 2 GiB")
                if len(prefix) < _MP4_PREFIX_LIMIT:
                    prefix.extend(chunk[:_MP4_PREFIX_LIMIT - len(prefix)])
                file.write(chunk)
        if total < MIN_VIDEO_BYTES:
            raise ValueError("视频文件小于 1KB")
        if not _is_supported_video(bytes(prefix)):
            raise ValueError("直链响应不是支持的 MP4 或 WebM 视频")
        temporary.replace(target)
        return result
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        close = getattr(response, "close", None)
        if callable(close):
            close()
