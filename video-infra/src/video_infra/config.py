from __future__ import annotations

from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
WORKSPACE_ROOT = PACKAGE_ROOT.parent
DEFAULT_OUTPUT_ROOT = WORKSPACE_ROOT / "out" / "video-infra"


def resolve_output_root(value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return DEFAULT_OUTPUT_ROOT
