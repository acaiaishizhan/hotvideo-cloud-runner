from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from ..schema import VideoResult


class VideoProvider(ABC):
    name = "base"
    platform = "unknown"

    @abstractmethod
    def supports(self, url: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def parse(self, url: str) -> VideoResult:
        raise NotImplementedError

    @abstractmethod
    def download(self, url: str, output_dir: Path | None = None, format_id: str | None = None) -> VideoResult:
        raise NotImplementedError
