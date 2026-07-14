from __future__ import annotations

from pathlib import Path

from .providers import DouyinProvider, YtDlpGenericProvider
from .providers.base import VideoProvider
from .schema import VideoResult
from .storage.paths import build_paths


class VideoRouter:
    def __init__(self):
        self.providers: list[VideoProvider] = [
            DouyinProvider(),
            YtDlpGenericProvider(),
        ]

    def select(self, url: str, platform: str = "auto") -> VideoProvider:
        wanted = platform.lower()
        if wanted != "auto":
            aliases = {
                "douyin": "douyin-direct",
                "youtube": "yt-dlp",
                "tiktok": "yt-dlp",
                "bilibili": "yt-dlp",
                "generic": "yt-dlp",
                "yt-dlp": "yt-dlp",
            }
            provider_name = aliases.get(wanted, wanted)
            for provider in self.providers:
                if provider.name == provider_name or provider.platform == wanted:
                    return provider
            raise ValueError(f"unknown platform/provider: {platform}")

        for provider in self.providers:
            if provider.supports(url):
                return provider
        raise ValueError("no provider supports this url")

    def parse(self, url: str, platform: str = "auto") -> VideoResult:
        return self.select(url, platform).parse(url)

    def download(self, url: str, platform: str = "auto", output_dir: str | None = None, format_id: str | None = None) -> VideoResult:
        provider = self.select(url, platform)
        if output_dir:
            target_dir = Path(output_dir).expanduser().resolve()
        else:
            parsed = provider.parse(url)
            target_dir = build_paths(None, parsed.platform, parsed.id).video_dir
        return provider.download(url, target_dir, format_id)
