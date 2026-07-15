import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TARGET_BYTES = 20 * 1024 * 1024;
const DEFAULT_AUDIO_KBPS = 32;
const DEFAULT_MIN_VIDEO_KBPS = 48;
const DEFAULT_MAX_VIDEO_KBPS = 300;
const DEFAULT_TIMEOUT_MS = 1800000;
const DEFAULT_CHUNK_SECONDS = 180;
const MIN_VALID_BYTES = 1024;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveAnalysisProxyOptions(env = process.env, durationSec = 0) {
  const targetBytes = positiveInt(env.HOTVIDEO_ANALYZE_PROXY_TARGET_BYTES, DEFAULT_TARGET_BYTES);
  const audioKbps = positiveInt(env.HOTVIDEO_ANALYZE_PROXY_AUDIO_KBPS, DEFAULT_AUDIO_KBPS);
  const minVideoKbps = positiveInt(env.HOTVIDEO_ANALYZE_PROXY_MIN_VIDEO_KBPS, DEFAULT_MIN_VIDEO_KBPS);
  const maxVideoKbps = positiveInt(env.HOTVIDEO_ANALYZE_PROXY_MAX_VIDEO_KBPS, DEFAULT_MAX_VIDEO_KBPS);
  const totalKbps = durationSec > 0
    ? Math.floor((targetBytes * 8) / 1000 / durationSec)
    : maxVideoKbps + audioKbps;
  const videoKbps = Math.max(minVideoKbps, Math.min(maxVideoKbps, totalKbps - audioKbps));
  return {
    ffmpeg: env.HOTVIDEO_ANALYZE_PROXY_FFMPEG || 'ffmpeg',
    targetBytes,
    audioKbps,
    videoKbps,
    timeoutMs: positiveInt(env.HOTVIDEO_ANALYZE_PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function buildAnalysisProxyArgs(inputPath, outputPath, options) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-vf', 'scale=-2:360:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=4',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-g', '240',
    '-keyint_min', '240',
    '-sc_threshold', '0',
    '-b:v', `${options.videoKbps}k`,
    '-maxrate', `${options.videoKbps}k`,
    '-bufsize', `${options.videoKbps * 2}k`,
    '-c:a', 'aac',
    '-b:a', `${options.audioKbps}k`,
    '-ac', '1',
    '-ar', '16000',
    '-sn',
    '-dn',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export function buildAnalysisChunkArgs(inputPath, outputPattern, segmentSeconds = DEFAULT_CHUNK_SECONDS) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-reset_timestamps', '1',
    outputPattern,
  ];
}

export function prepareAnalysisVideoChunks(videoPath, env = process.env) {
  const segmentSeconds = positiveInt(env.HOTVIDEO_ANALYZE_CHUNK_SECONDS, DEFAULT_CHUNK_SECONDS);
  const timeoutMs = positiveInt(env.HOTVIDEO_ANALYZE_PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const ffmpeg = env.HOTVIDEO_ANALYZE_PROXY_FFMPEG || 'ffmpeg';
  const chunksDir = path.join(path.dirname(videoPath), '.hotvideo-analysis-chunks');
  const outputPattern = path.join(chunksDir, 'chunk-%03d.mp4');
  fs.rmSync(chunksDir, { recursive: true, force: true });
  fs.mkdirSync(chunksDir, { recursive: true });
  try {
    execFileSync(ffmpeg, buildAnalysisChunkArgs(videoPath, outputPattern, segmentSeconds), {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const chunks = fs.readdirSync(chunksDir)
      .filter(name => /^chunk-\d+\.mp4$/.test(name))
      .sort()
      .map(name => path.join(chunksDir, name))
      .filter(filePath => fs.statSync(filePath).size >= MIN_VALID_BYTES);
    if (chunks.length === 0) throw new Error('未生成有效分段');
    return chunks;
  } catch (error) {
    fs.rmSync(chunksDir, { recursive: true, force: true });
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf-8').trim() : '';
    throw new Error(`生成分析分段失败: ${stderr || error.message}`);
  }
}

function validCachedProxy(proxyPath, sourceStat) {
  try {
    const proxyStat = fs.statSync(proxyPath);
    return proxyStat.size >= MIN_VALID_BYTES && proxyStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

export function prepareAnalysisVideoProxy(videoPath, durationSec, env = process.env) {
  const sourceStat = fs.statSync(videoPath);
  const proxyPath = path.join(path.dirname(videoPath), '.hotvideo-analysis-proxy.mp4');
  if (validCachedProxy(proxyPath, sourceStat)) {
    return {
      path: proxyPath,
      cached: true,
      sourceBytes: sourceStat.size,
      proxyBytes: fs.statSync(proxyPath).size,
    };
  }

  const options = resolveAnalysisProxyOptions(env, durationSec);
  const tempPath = path.join(path.dirname(videoPath), '.hotvideo-analysis-proxy.part.mp4');
  try {
    fs.rmSync(tempPath, { force: true });
    execFileSync(options.ffmpeg, buildAnalysisProxyArgs(videoPath, tempPath, options), {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const proxyStat = fs.statSync(tempPath);
    if (proxyStat.size < MIN_VALID_BYTES) {
      throw new Error(`分析副本无效: ${tempPath}`);
    }
    fs.rmSync(proxyPath, { force: true });
    fs.renameSync(tempPath, proxyPath);
    return {
      path: proxyPath,
      cached: false,
      sourceBytes: sourceStat.size,
      proxyBytes: proxyStat.size,
    };
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore cleanup failure */ }
    const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf-8').trim() : '';
    throw new Error(`生成长视频分析副本失败: ${stderr || err.message}`);
  }
}
