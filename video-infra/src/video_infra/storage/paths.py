from __future__ import annotations

import re
from pathlib import Path

from ..config import resolve_output_root


def safe_name(value: str, fallback: str = "video") -> str:
    cleaned = re.sub(r'[\\/*?:"<>|\n\r\t#@]', "_", value or "").strip("_. ")
    cleaned = re.sub(r"_+", "_", cleaned)
    return (cleaned or fallback)[:90]


class OutputPaths:
    def __init__(self, root: Path, platform: str, video_id: str):
        self.root = root
        self.platform = safe_name(platform, "unknown")
        self.video_id = safe_name(video_id, "unknown")

    @property
    def video_dir(self) -> Path:
        return self.root / "videos" / self.platform / self.video_id

    @property
    def metadata_dir(self) -> Path:
        return self.root / "metadata" / self.platform

    @property
    def thumbnail_dir(self) -> Path:
        return self.root / "thumbnails" / self.platform

    @property
    def subtitle_dir(self) -> Path:
        return self.root / "subtitles" / self.platform / self.video_id

    @property
    def metadata_path(self) -> Path:
        return self.metadata_dir / f"{self.video_id}.json"


def build_paths(output_dir: str | None, platform: str, video_id: str) -> OutputPaths:
    return OutputPaths(resolve_output_root(output_dir), platform, video_id)
