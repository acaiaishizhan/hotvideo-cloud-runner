from __future__ import annotations

import argparse
import json
import sys

from .router import VideoRouter
from .schema import VideoResult, error_result
from .storage.metadata import write_metadata
from .storage.paths import build_paths

# Windows 默认 stdout 是 GBK，遇到 emoji 会抛 UnicodeEncodeError；
# 这里强制 UTF-8，避免上游 Node/PowerShell 调用时拿到的是异常而不是 JSON。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]


def _print(result: VideoResult) -> int:
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


def _write_meta_if_needed(result: VideoResult, output_dir: str | None, write_meta: bool) -> None:
    if not write_meta or not result.ok:
        return
    if output_dir:
        meta_path = build_paths(output_dir, result.platform, result.id).root / "meta.json"
    else:
        meta_path = build_paths(None, result.platform, result.id).metadata_path
    write_metadata(result, meta_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="video-infra", description="Video metadata and download infrastructure.")
    sub = parser.add_subparsers(dest="command", required=True)

    parse_cmd = sub.add_parser("parse", help="Parse video metadata without downloading.")
    parse_cmd.add_argument("url")
    parse_cmd.add_argument("--platform", default="auto")
    parse_cmd.add_argument("--output-dir", default=None)
    parse_cmd.add_argument("--write-meta", action="store_true")

    download_cmd = sub.add_parser("download", help="Download video and return normalized metadata.")
    download_cmd.add_argument("url")
    download_cmd.add_argument("--platform", default="auto")
    download_cmd.add_argument("--output-dir", default=None)
    download_cmd.add_argument("--format-id", default=None)
    download_cmd.add_argument("--no-write-meta", action="store_true")

    fetch_cmd = sub.add_parser("fetch", help="Parse, download, and write metadata.")
    fetch_cmd.add_argument("url")
    fetch_cmd.add_argument("--platform", default="auto")
    fetch_cmd.add_argument("--output-dir", default=None)
    fetch_cmd.add_argument("--format-id", default=None)
    fetch_cmd.add_argument("--no-write-meta", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    router = VideoRouter()
    try:
        if args.command == "parse":
            result = router.parse(args.url, args.platform)
            _write_meta_if_needed(result, args.output_dir, args.write_meta)
            return _print(result)

        if args.command in {"download", "fetch"}:
            result = router.download(args.url, args.platform, args.output_dir, args.format_id)
            _write_meta_if_needed(result, args.output_dir, not args.no_write_meta)
            return _print(result)

        return _print(error_result(f"unknown command: {args.command}"))
    except Exception as exc:
        return _print(error_result(str(exc)))


if __name__ == "__main__":
    sys.exit(main())
