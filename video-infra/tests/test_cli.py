from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from video_infra.cli import main
from video_infra.schema import VideoResult


class _NoisyRouter:
    def download(self, *_args):
        print("[download] progress")
        return VideoResult(platform="youtube", provider="yt-dlp", id="abc")


class CliOutputTest(unittest.TestCase):
    def test_provider_progress_goes_to_stderr_and_stdout_stays_json(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch("video_infra.cli.VideoRouter", return_value=_NoisyRouter()):
            with redirect_stdout(stdout), redirect_stderr(stderr):
                exit_code = main(["download", "https://youtube.com/watch?v=abc", "--no-write-meta"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["id"], "abc")
        self.assertIn("[download] progress", stderr.getvalue())
        self.assertNotIn("[download] progress", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
