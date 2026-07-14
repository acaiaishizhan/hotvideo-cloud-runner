from __future__ import annotations

import json
from pathlib import Path

from ..schema import VideoResult


def write_metadata(result: VideoResult, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    result.files.metadataPath = str(path)
    path.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return path
