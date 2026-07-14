from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

from ..schema import Author, Media, Stats, VideoResult
from ..storage.paths import safe_name
from .base import VideoProvider


URL_PATTERN = re.compile(r"https?://[^\s]+", re.IGNORECASE)
DOUYIN_DOMAINS = ("douyin.com", "iesdouyin.com", "v.douyin.com", "m.douyin.com")

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/json,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.douyin.com/",
}

MOBILE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.douyin.com/",
}


class DouyinProvider(VideoProvider):
    name = "douyin-direct"
    platform = "douyin"
    api_url = "https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.timeout = (10, 30)

    def supports(self, url: str) -> bool:
        try:
            host = urlparse(self._extract_url(url)).netloc.lower()
        except ValueError:
            return False
        return any(domain in host for domain in DOUYIN_DOMAINS)

    def parse(self, url: str) -> VideoResult:
        source_url = self._extract_url(url)
        resolved_url = self._resolve_redirect(source_url)
        video_id = self._extract_video_id(resolved_url)
        item = self._fetch_item_info(video_id, resolved_url)
        return self._build_result(item, video_id, source_url, resolved_url)

    def download(self, url: str, output_dir: Path | None = None, format_id: str | None = None) -> VideoResult:
        result = self.parse(url)
        media_url = result.media.directUrl
        if not media_url:
            raise ValueError("douyin media direct url is empty")

        target_dir = output_dir or Path.cwd()
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = "video.mp4" if output_dir else f"{safe_name(result.title, result.id)}.mp4"
        filepath = target_dir / filename
        self._download_file(media_url, filepath)
        result.files.videoPath = str(filepath)
        return result

    def _extract_url(self, text: str) -> str:
        match = URL_PATTERN.search(text)
        if not match:
            raise ValueError("未找到有效的抖音链接")
        return match.group(0).strip().strip('"').strip("'").rstrip(").,;!?")

    def _resolve_redirect(self, url: str) -> str:
        last_error = None
        for attempt in range(3):
            try:
                resp = self.session.get(url, timeout=self.timeout, allow_redirects=True, headers=DEFAULT_HEADERS)
                resp.raise_for_status()
                return resp.url
            except requests.RequestException as exc:
                last_error = exc
                time.sleep(1 * (2 ** attempt))
        raise ValueError(f"链接解析失败: {last_error}")

    def _extract_video_id(self, url: str) -> str:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        for key in ("modal_id", "item_ids", "group_id", "aweme_id"):
            values = query.get(key)
            if values:
                match = re.search(r"(\d{8,24})", values[0])
                if match:
                    return match.group(1)
        for pattern in (r"/video/(\d{8,24})", r"/note/(\d{8,24})", r"/(\d{8,24})(?:/|$)"):
            match = re.search(pattern, parsed.path)
            if match:
                return match.group(1)
        fallback = re.search(r"(\d{15,24})", url)
        if fallback:
            return fallback.group(1)
        raise ValueError("无法从链接中提取视频 ID")

    def _fetch_item_info(self, video_id: str, resolved_url: str) -> dict:
        try:
            return self._fetch_via_api(video_id)
        except Exception:
            return self._fetch_via_share_page(video_id, resolved_url)

    def _fetch_via_api(self, video_id: str) -> dict:
        last_error = None
        for attempt in range(3):
            try:
                resp = self.session.get(self.api_url, params={"item_ids": video_id}, timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
                items = data.get("item_list") or []
                if not items:
                    raise ValueError("抖音 API 返回空数据")
                return items[0]
            except Exception as exc:
                last_error = exc
                time.sleep(1 * (2 ** attempt))
        raise ValueError(f"抖音 API 解析失败: {last_error}")

    def _fetch_via_share_page(self, video_id: str, resolved_url: str) -> dict:
        parsed = urlparse(resolved_url)
        share_url = resolved_url if "iesdouyin.com" in (parsed.netloc or "") else f"https://www.iesdouyin.com/share/video/{video_id}/"
        resp = self.session.get(share_url, headers=MOBILE_HEADERS, timeout=self.timeout)
        resp.raise_for_status()
        html = resp.text or ""
        if "Please wait..." in html and "wci=" in html and "cs=" in html:
            html = self._solve_waf_and_retry(html, share_url)
        router_data = self._extract_router_data(html)
        loader_data = router_data.get("loaderData", {})
        for node in loader_data.values():
            if not isinstance(node, dict):
                continue
            item_list = (node.get("videoInfoRes") or {}).get("item_list") or []
            if item_list and isinstance(item_list[0], dict):
                return item_list[0]
        raise ValueError("无法从分享页提取视频信息")

    def _solve_waf_and_retry(self, html: str, page_url: str) -> str:
        match = re.search(r'wci="([^"]+)"\s*,\s*cs="([^"]+)"', html)
        if not match:
            return html
        cookie_name, challenge_blob = match.groups()
        try:
            challenge_data = json.loads(self._decode_b64(challenge_blob).decode("utf-8"))
            prefix = self._decode_b64(challenge_data["v"]["a"])
            expected = self._decode_b64(challenge_data["v"]["c"]).hex()
        except Exception:
            return html
        for candidate in range(1_000_001):
            digest = hashlib.sha256(prefix + str(candidate).encode()).hexdigest()
            if digest == expected:
                challenge_data["d"] = base64.b64encode(str(candidate).encode()).decode()
                cookie_val = base64.b64encode(json.dumps(challenge_data, separators=(",", ":")).encode()).decode()
                domain = urlparse(page_url).hostname or "www.iesdouyin.com"
                self.session.cookies.set(cookie_name, cookie_val, domain=domain, path="/")
                return self.session.get(page_url, headers=MOBILE_HEADERS, timeout=self.timeout).text or html
        return html

    @staticmethod
    def _decode_b64(value: str) -> bytes:
        normalized = value.replace("-", "+").replace("_", "/")
        normalized += "=" * (-len(normalized) % 4)
        return base64.b64decode(normalized)

    @staticmethod
    def _extract_router_data(html: str) -> dict:
        marker = "window._ROUTER_DATA = "
        start = html.find(marker)
        if start < 0:
            return {}
        idx = start + len(marker)
        while idx < len(html) and html[idx].isspace():
            idx += 1
        if idx >= len(html) or html[idx] != "{":
            return {}
        depth = 0
        in_str = False
        escaped = False
        for cursor in range(idx, len(html)):
            ch = html[cursor]
            if in_str:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(html[idx:cursor + 1])
                    except ValueError:
                        return {}
        return {}

    def _build_result(self, item: dict, video_id: str, source_url: str, resolved_url: str) -> VideoResult:
        title = item.get("desc") or f"抖音视频_{video_id}"
        author = item.get("author") or {}
        stats = item.get("statistics") or {}
        video = item.get("video") or {}
        play_urls = ((video.get("play_addr") or {}).get("url_list") or [])
        cover_urls = ((video.get("cover") or {}).get("url_list") or [])
        direct_url = play_urls[0].replace("playwm", "play") if play_urls else ""
        duration_ms = video.get("duration") or 0
        duration_sec = duration_ms // 1000 if duration_ms and duration_ms > 1000 else duration_ms or None
        width = video.get("width") or 0
        height = video.get("height") or 0
        formats = []
        if direct_url:
            formats.append({
                "formatId": "douyin_nowm",
                "ext": "mp4",
                "width": width or None,
                "height": height or None,
                "resolution": f"{width}x{height}" if width and height else "",
                "vcodec": "h264",
                "acodec": "aac",
                "hasAudio": True,
                "url": direct_url,
            })
        return VideoResult(
            platform="douyin",
            provider=self.name,
            id=video_id,
            canonicalUrl=f"https://www.douyin.com/video/{video_id}",
            sourceUrl=source_url,
            title=title,
            description=title,
            author=Author(
                id=str(author.get("uid") or author.get("sec_uid") or ""),
                name=author.get("nickname") or "",
                avatarUrl=(((author.get("avatar_thumb") or {}).get("url_list")) or [""])[0],
                profileUrl=f"https://www.douyin.com/user/{author.get('sec_uid')}" if author.get("sec_uid") else "",
                followerCount=author.get("follower_count"),
            ),
            durationSec=duration_sec,
            publishedAt=str(item.get("create_time")) if item.get("create_time") else None,
            thumbnailUrl=cover_urls[0] if cover_urls else "",
            stats=Stats(
                viewCount=stats.get("play_count"),
                likeCount=stats.get("digg_count"),
                commentCount=stats.get("comment_count"),
                shareCount=stats.get("share_count"),
                favoriteCount=stats.get("collect_count"),
            ),
            media=Media(formats=formats, directUrl=direct_url),
            subtitles=[],
            raw={"resolvedUrl": resolved_url, "item": item},
        )

    def _download_file(self, url: str, filepath: Path, chunk_size: int = 64 * 1024) -> None:
        temp_path = filepath.with_suffix(filepath.suffix + ".part")
        last_error = None
        for attempt in range(3):
            try:
                resp = self.session.get(url, stream=True, timeout=self.timeout, allow_redirects=True)
                resp.raise_for_status()
                with temp_path.open("wb") as f:
                    for chunk in resp.iter_content(chunk_size=chunk_size):
                        if chunk:
                            f.write(chunk)
                temp_path.replace(filepath)
                return
            except Exception as exc:
                last_error = exc
                time.sleep(1 * (2 ** attempt))
        raise ValueError(f"文件下载失败: {last_error}")
