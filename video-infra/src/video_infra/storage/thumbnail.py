from pathlib import Path

import requests


def image_extension(data: bytes) -> str:
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    raise ValueError("封面响应不是支持的图片格式")


def download_thumbnail(url: str, output_dir: str, *, get=requests.get) -> Path:
    if not url.startswith(("https://", "http://")):
        raise ValueError("缺少有效封面地址")
    data = bytearray()
    with get(url, stream=True, timeout=(10, 30)) as response:
        response.raise_for_status()
        for chunk in response.iter_content(65536):
            data.extend(chunk)
            if len(data) > 10 * 1024 * 1024:
                raise ValueError("封面超过 10 MiB")
    if len(data) < 100:
        raise ValueError("封面图片过小")
    extension = image_extension(data)
    directory = Path(output_dir).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"cover.{extension}"
    temporary = target.with_suffix(target.suffix + ".part")
    temporary.write_bytes(data)
    temporary.replace(target)
    return target
