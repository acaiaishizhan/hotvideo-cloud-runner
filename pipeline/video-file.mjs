import fs from 'node:fs';
import path from 'node:path';

const MIN_VIDEO_BYTES = 1024;

export function isValidVideoFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size >= MIN_VIDEO_BYTES;
  } catch {
    return false;
  }
}

export function resolveVideoPath(videoDir, meta = {}) {
  return meta.files?.videoPath
    ? path.resolve(meta.files.videoPath)
    : path.join(videoDir, 'video.mp4');
}
