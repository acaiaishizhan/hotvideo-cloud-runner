from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Author:
    id: str = ""
    name: str = ""
    avatarUrl: str = ""
    profileUrl: str = ""
    followerCount: int | None = None


@dataclass
class Stats:
    viewCount: int | None = None
    likeCount: int | None = None
    commentCount: int | None = None
    shareCount: int | None = None
    favoriteCount: int | None = None
    repostCount: int | None = None


@dataclass
class Media:
    formats: list[dict[str, Any]] = field(default_factory=list)
    directUrl: str = ""
    directUrlExpiresAt: str | None = None


@dataclass
class Files:
    videoPath: str | None = None
    thumbnailPath: str | None = None
    metadataPath: str | None = None
    subtitlePaths: list[str] = field(default_factory=list)


@dataclass
class VideoResult:
    ok: bool = True
    platform: str = "unknown"
    provider: str = "unknown"
    id: str = ""
    canonicalUrl: str = ""
    sourceUrl: str = ""
    title: str = ""
    description: str = ""
    author: Author = field(default_factory=Author)
    durationSec: int | None = None
    publishedAt: str | None = None
    thumbnailUrl: str = ""
    stats: Stats = field(default_factory=Stats)
    media: Media = field(default_factory=Media)
    subtitles: list[dict[str, Any]] = field(default_factory=list)
    files: Files = field(default_factory=Files)
    raw: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def error_result(message: str, *, platform: str = "unknown", provider: str = "unknown") -> VideoResult:
    return VideoResult(ok=False, platform=platform, provider=provider, error=message)
