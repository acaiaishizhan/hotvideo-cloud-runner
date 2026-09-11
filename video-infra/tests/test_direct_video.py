import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from video_infra.cli import main
from video_infra.schema import VideoResult
from video_infra.storage.direct_video import download_direct_video


def mp4_bytes(size=1200):
    return b"\x00\x00\x00\x18ftypisom" + b"x" * (size - 12)


class Response:
    def __init__(self, data, headers=None, error=None):
        self.data = data
        self.headers = headers or {}
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise self.error

    def iter_content(self, chunk_size):
        yield self.data


class DirectVideoTest(unittest.TestCase):
    def metadata(self):
        return {
            "id": "123", "platform": "douyin", "canonicalUrl": "https://www.douyin.com/video/123",
            "title": "标题", "description": "描述", "author": {"id": "author", "name": "作者"},
            "durationSec": 12, "publishedAt": "2026-09-11T00:00:00Z", "thumbnailUrl": "https://example.com/cover.jpg",
            "stats": {"viewCount": 0, "likeCount": 5},
        }

    def test_valid_mp4_is_atomically_saved_with_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            result = download_direct_video("https://media.example/video", directory, self.metadata(), get=lambda *_a, **_k: Response(mp4_bytes()))
            target = Path(directory) / "video.mp4"
            self.assertEqual(target.read_bytes(), mp4_bytes())
            self.assertFalse((Path(directory) / "video.mp4.part").exists())
            self.assertEqual(result.provider, "direct-media")
            self.assertEqual(result.files.videoPath, str(target.resolve()))
            self.assertEqual(result.stats.viewCount, 0)
            self.assertEqual(result.author.name, "作者")

    def test_html_success_response_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "不是视频"):
                download_direct_video("https://media.example/video", directory, self.metadata(), get=lambda *_a, **_k: Response(b"<html>denied</html>" * 100, {"Content-Type": "text/html"}))
            self.assertFalse((Path(directory) / "video.mp4").exists())

    def test_small_or_failed_download_never_publishes_partial_video(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "video.mp4"
            target.write_bytes(b"existing video")
            with self.assertRaisesRegex(ValueError, "小于 1KB"):
                download_direct_video("https://media.example/video", directory, self.metadata(), get=lambda *_a, **_k: Response(mp4_bytes(999)))
            with self.assertRaisesRegex(RuntimeError, "network"):
                download_direct_video("https://media.example/video", directory, self.metadata(), get=lambda *_a, **_k: Response(b"", error=RuntimeError("network")))
            self.assertEqual(target.read_bytes(), b"existing video")
            self.assertFalse((Path(directory) / "video.mp4.part").exists())

    def test_oversized_response_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "2 GiB"):
                download_direct_video("https://media.example/video", directory, self.metadata(), get=lambda *_a, **_k: Response(b"", {"Content-Length": str(2 * 1024 * 1024 * 1024 + 1)}))
            self.assertFalse((Path(directory) / "video.mp4").exists())

    def test_cli_prints_json_and_returns_nonzero_on_error(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path = Path(directory) / "metadata.json"
            metadata_path.write_text(json.dumps(self.metadata()), encoding="utf-8")
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch("video_infra.cli.download_direct_video", return_value=VideoResult(id="123", provider="direct-media")):
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    self.assertEqual(main(["download-direct", "https://media.example/video", "--output-dir", directory, "--metadata-file", str(metadata_path)]), 0)
            self.assertEqual(json.loads(stdout.getvalue())["id"], "123")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                self.assertEqual(main(["download-direct", "https://media.example/video", "--output-dir", directory, "--metadata-file", str(Path(directory) / "missing.json")]), 1)
            self.assertFalse(json.loads(stdout.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
