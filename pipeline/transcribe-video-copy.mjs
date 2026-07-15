#!/usr/bin/env node
// ============================================================
//  本地 faster-whisper 转写：video.mp4 -> transcript.json/txt
// ============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 1800000;
const MIN_VIDEO_BYTES = 1024;

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

export function resolveTranscribeOptions(env = process.env) {
  return {
    python: env.HOTVIDEO_TRANSCRIBE_PYTHON || 'python',
    model: env.HOTVIDEO_TRANSCRIBE_MODEL || 'large-v3',
    device: env.HOTVIDEO_TRANSCRIBE_DEVICE || 'auto',
    computeType: env.HOTVIDEO_TRANSCRIBE_COMPUTE_TYPE || 'auto',
    timeoutMs: Number.parseInt(env.HOTVIDEO_TRANSCRIBE_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
  };
}

export function isValidVideoFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size >= MIN_VIDEO_BYTES;
  } catch {
    return false;
  }
}

export function hasFullVideoCopy(meta) {
  return typeof meta?.analysis?.full_video_copy === 'string'
    && meta.analysis.full_video_copy.trim().length > 0;
}

export function resolveVideoPath(videoDir, meta = {}) {
  return meta.files?.videoPath
    ? path.resolve(meta.files.videoPath)
    : path.join(videoDir, 'video.mp4');
}

export function transcriptPaths(videoDir) {
  return {
    audioPath: path.join(videoDir, '.hotvideo-transcribe.wav'),
    jsonPath: path.join(videoDir, 'transcript.json'),
    textPath: path.join(videoDir, 'transcript.txt'),
  };
}

export function fullVideoCopyFromTranscript(result) {
  if (typeof result?.full_text === 'string') return result.full_text.trim();
  if (Array.isArray(result?.segments)) {
    return result.segments
      .map(seg => typeof seg?.text === 'string' ? seg.text.trim() : '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

export function mergeFullVideoCopy(meta, fullVideoCopy, transcriptMeta = {}) {
  const next = {
    ...meta,
    analysis: {
      ...(meta.analysis || {}),
      full_video_copy: typeof fullVideoCopy === 'string' ? fullVideoCopy : '',
    },
  };
  next.transcript = {
    ...(meta.transcript || {}),
    status: 'done',
    transcribedAt: transcriptMeta.transcribedAt || new Date().toISOString(),
    jsonPath: transcriptMeta.jsonPath,
    textPath: transcriptMeta.textPath,
    provider: transcriptMeta.provider,
    model: transcriptMeta.model,
    device: transcriptMeta.device,
    computeType: transcriptMeta.computeType,
    audioAccess: transcriptMeta.audioAccess,
    confidence: transcriptMeta.confidence,
  };
  return next;
}

function scriptPath() {
  return path.join(import.meta.dirname, 'transcribe-video-copy.py');
}

function extractAudio(videoPath, audioPath, timeoutMs) {
  execFileSync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    audioPath,
  ], {
    encoding: 'utf-8',
    timeout: Math.min(timeoutMs, 600000),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runWhisper(audioPath, outputPath, options) {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    HOTVIDEO_TRANSCRIBE_MODEL: options.model,
    HOTVIDEO_TRANSCRIBE_DEVICE: options.device,
    HOTVIDEO_TRANSCRIBE_COMPUTE_TYPE: options.computeType,
  };
  execFileSync(options.python, [scriptPath(), audioPath, outputPath], {
    encoding: 'utf-8',
    timeout: options.timeoutMs,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function readCachedTranscript(videoDir) {
  const { jsonPath, textPath } = transcriptPaths(videoDir);
  if (!fs.existsSync(jsonPath)) return null;
  const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const fullVideoCopy = fullVideoCopyFromTranscript(result);
  if (fullVideoCopy && !fs.existsSync(textPath)) {
    fs.writeFileSync(textPath, fullVideoCopy, 'utf-8');
  }
  return { result, fullVideoCopy, jsonPath, textPath, cached: true };
}

export function transcribeVideoCopy(videoDir, meta = {}, opts = {}) {
  const videoPath = resolveVideoPath(videoDir, meta);
  if (!isValidVideoFile(videoPath)) {
    throw new Error(`视频文件不存在或无效: ${videoPath}`);
  }

  const cached = readCachedTranscript(videoDir);
  if (cached) return cached;

  const options = { ...resolveTranscribeOptions(), ...opts };
  const { audioPath, jsonPath, textPath } = transcriptPaths(videoDir);

  fs.mkdirSync(videoDir, { recursive: true });
  try {
    log(`  转写音频: ${path.basename(videoPath)} (${options.model}, ${options.device}/${options.computeType})`);
    extractAudio(videoPath, audioPath, options.timeoutMs);
    runWhisper(audioPath, jsonPath, options);
    const result = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const fullVideoCopy = fullVideoCopyFromTranscript(result);
    fs.writeFileSync(textPath, fullVideoCopy, 'utf-8');
    return { result, fullVideoCopy, jsonPath, textPath, cached: false };
  } finally {
    try { fs.unlinkSync(audioPath); } catch (_) {}
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const videoDir = args[0];
  if (!videoDir) throw new Error('用法: node pipeline/transcribe-video-copy.mjs <videoDir>');
  return { videoDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { videoDir } = parseArgs(process.argv);
    const metaPath = path.join(videoDir, 'meta.json');
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};
    const output = transcribeVideoCopy(videoDir, meta);
    console.log(JSON.stringify({
      ok: true,
      chars: output.fullVideoCopy.length,
      jsonPath: output.jsonPath,
      textPath: output.textPath,
      cached: output.cached,
    }, null, 2));
  } catch (err) {
    console.error(`转写失败: ${err.message}`);
    process.exit(1);
  }
}
