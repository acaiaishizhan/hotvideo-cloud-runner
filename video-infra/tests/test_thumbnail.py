import tempfile
import unittest
from pathlib import Path

from video_infra.storage.thumbnail import download_thumbnail


class Response:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, size):
        yield self.data


class ThumbnailTest(unittest.TestCase):
    def test_html_error_page_is_not_saved_as_image(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "图片格式"):
                download_thumbnail("https://example.com/cover", directory,
                                   get=lambda *a, **k: Response(b"<html>denied</html>" * 20))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_image_saved_using_bytes_not_url_extension(self):
        image = b"\xff\xd8\xff" + b"x" * 200
        with tempfile.TemporaryDirectory() as directory:
            file = download_thumbnail("https://example.com/cover?signature=abc", directory,
                                      get=lambda *a, **k: Response(image))
            self.assertEqual(file.name, "cover.jpg")
            self.assertEqual(file.read_bytes(), image)
            self.assertFalse(file.with_suffix(".jpg.part").exists())

    def test_oversized_image_does_not_create_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "10 MiB"):
                download_thumbnail("https://example.com/image", directory,
                                   get=lambda *a, **k: Response(b"x" * (10 * 1024 * 1024 + 1)))
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
