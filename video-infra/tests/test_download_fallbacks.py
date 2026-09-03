from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_infra.providers.douyin import DouyinProvider
from video_infra.providers.yt_dlp_generic import YtDlpGenericProvider
from video_infra.schema import VideoResult


class _Fallback:
    def parse(self, url: str) -> VideoResult:
        return VideoResult(platform="douyin", provider="yt-dlp", id=url.rsplit("/", 1)[-1])

    def download(self, url: str, output_dir=None, format_id=None) -> VideoResult:
        result = self.parse(url)
        result.files.videoPath = str(Path(output_dir or ".") / "video.mp4")
        return result


class _FlakyCookieFallback(_Fallback):
    def __init__(self):
        self.parse_calls = 0

    def parse(self, url: str) -> VideoResult:
        self.parse_calls += 1
        if self.parse_calls == 1:
            raise ValueError("Fresh cookies are needed")
        return super().parse(url)


class DownloadFallbackTest(unittest.TestCase):
    def test_douyin_parse_uses_yt_dlp_after_direct_parser_failure(self):
        provider = DouyinProvider(fallback=_Fallback())
        with patch.object(provider, "_parse_direct", side_effect=ValueError("JSVM challenge")):
            result = provider.parse("https://www.douyin.com/video/7680911353162272010")
        self.assertEqual(result.provider, "yt-dlp")
        self.assertEqual(result.id, "7680911353162272010")

    def test_douyin_download_uses_yt_dlp_after_direct_parser_failure(self):
        provider = DouyinProvider(fallback=_Fallback())
        with patch.object(provider, "_parse_direct", side_effect=ValueError("JSVM challenge")):
            result = provider.download("https://www.douyin.com/video/7680911353162272010", Path("out"))
        self.assertEqual(result.files.videoPath, str(Path("out") / "video.mp4"))

    def test_douyin_rebuilds_ephemeral_profile_once_after_cookie_challenge(self):
        fallback = _FlakyCookieFallback()
        provider = DouyinProvider(fallback=fallback)
        with patch.dict(os.environ, {"VIDEO_INFRA_DOUYIN_BROWSER_PROFILE": ""}, clear=False):
            with patch.object(provider, "_parse_direct", side_effect=ValueError("JSVM challenge")):
                result = provider.parse("https://www.douyin.com/video/7680911353162272010")
        self.assertEqual(result.id, "7680911353162272010")
        self.assertEqual(fallback.parse_calls, 2)

    def test_douyin_does_not_retry_a_non_cookie_fallback_error(self):
        fallback = _FlakyCookieFallback()
        fallback.parse = lambda _url: (_ for _ in ()).throw(ValueError("private video"))
        provider = DouyinProvider(fallback=fallback)
        with patch.object(provider, "_parse_direct", side_effect=ValueError("share page changed")):
            with self.assertRaisesRegex(ValueError, "private video"):
                provider.parse("https://www.douyin.com/video/1")

    def test_explicit_douyin_profile_is_passed_without_cookie_material(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"VIDEO_INFRA_DOUYIN_BROWSER_PROFILE": temp_dir}, clear=False):
                provider = DouyinProvider(fallback=_Fallback())
                with provider._yt_dlp_cookie_options("https://www.douyin.com/video/1") as options:
                    self.assertEqual(options["cookiesfrombrowser"][0], "chrome")
                    self.assertEqual(Path(options["cookiesfrombrowser"][1]), Path(temp_dir).resolve())

    def test_youtube_retries_with_android_vr_without_changing_other_platforms(self):
        youtube = YtDlpGenericProvider.option_candidates("https://www.youtube.com/watch?v=abc")
        self.assertEqual(len(youtube), 2)
        self.assertEqual(
            youtube[1]["extractor_args"],
            {"youtube": {"player_client": ["android_vr"]}},
        )
        self.assertEqual(
            YtDlpGenericProvider.option_candidates("https://www.bilibili.com/video/BV1xx"),
            [{}],
        )

    def test_youtube_retry_is_limited_to_observed_access_failures(self):
        self.assertTrue(YtDlpGenericProvider.should_try_next_candidate(
            "https://www.youtube.com/watch?v=abc",
            RuntimeError("HTTP Error 403: Forbidden"),
        ))
        self.assertTrue(YtDlpGenericProvider.should_try_next_candidate(
            "https://youtu.be/abc",
            RuntimeError("Sign in to confirm you're not a bot"),
        ))
        self.assertFalse(YtDlpGenericProvider.should_try_next_candidate(
            "https://www.youtube.com/watch?v=abc",
            RuntimeError("This live event will begin in 7 days"),
        ))
        self.assertFalse(YtDlpGenericProvider.should_try_next_candidate(
            "https://www.bilibili.com/video/BV1xx",
            RuntimeError("HTTP Error 403: Forbidden"),
        ))

    def test_youtube_extract_retries_once_with_android_vr_after_403(self):
        attempts = []

        class _Ydl:
            def __init__(self, options):
                self.options = options
                attempts.append(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=False):
                if "extractor_args" not in self.options:
                    raise RuntimeError("HTTP Error 403: Forbidden")
                return {"id": "abc", "title": "ok", "extractor_key": "Youtube", "formats": []}

        with patch("video_infra.providers.yt_dlp_generic.yt_dlp.YoutubeDL", _Ydl):
            result = YtDlpGenericProvider().parse("https://www.youtube.com/watch?v=abc")

        self.assertEqual(result.id, "abc")
        self.assertEqual(len(attempts), 2)
        self.assertEqual(
            attempts[1]["extractor_args"],
            {"youtube": {"player_client": ["android_vr"]}},
        )

    def test_youtube_extract_does_not_retry_a_future_live_event(self):
        attempts = []

        class _Ydl:
            def __init__(self, options):
                attempts.append(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=False):
                raise RuntimeError("This live event will begin in 7 days")

        with patch("video_infra.providers.yt_dlp_generic.yt_dlp.YoutubeDL", _Ydl):
            with self.assertRaisesRegex(RuntimeError, "live event"):
                YtDlpGenericProvider().parse("https://www.youtube.com/watch?v=abc")

        self.assertEqual(len(attempts), 1)

    def test_douyin_unconfigured_cookie_context_primes_a_batch_profile(self):
        provider = DouyinProvider(fallback=_Fallback())
        with tempfile.TemporaryDirectory() as temp_root:
            with patch.dict(os.environ, {"VIDEO_INFRA_DOUYIN_BROWSER_PROFILE": ""}, clear=False):
                with patch("video_infra.providers.douyin.tempfile.gettempdir", return_value=temp_root):
                    with patch.object(provider, "_prime_fresh_profile") as prime:
                        with provider._yt_dlp_cookie_options("https://www.douyin.com/video/1") as first:
                            first_profile = Path(first["cookiesfrombrowser"][1])
                        with provider._yt_dlp_cookie_options("https://www.douyin.com/video/1") as second:
                            second_profile = Path(second["cookiesfrombrowser"][1])
                        self.assertTrue(first_profile.exists())
                        self.assertEqual(first_profile, second_profile)
                        self.assertEqual(prime.call_count, 2)


if __name__ == "__main__":
    unittest.main()
