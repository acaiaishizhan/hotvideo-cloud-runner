#!/usr/bin/env node
// ============================================================
//  Doubao 视频口播转写：video.mp4 -> transcript.json/txt
//  只转写音频口播；没有可辨认口播时写空字符串，不做 OCR。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeJsonAtomic } from './json-file.mjs';
import {
  fullVideoCopyFromTranscript,
  isValidVideoFile,
  readCachedTranscript,
  resolveVideoPath,
  transcriptPaths,
} from './transcribe-video-copy.mjs';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const DEFAULT_MODEL = 'doubao-seed-2.0-pro';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_VIDEO_BYTES = 32 * 1024 * 1024;

function readArkKeyFromDotEnv() {
  const envPath = path.join(WORKSPACE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return '';
  const text = fs.readFileSync(envPath, 'utf-8');
  const line = text.split(/\r?\n/).find(item => item.startsWith('ARK_API_KEY='));
  if (!line) return '';
  return line.split('=', 2)[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
}

export function resolveDoubaoVideoCopyOptions(env = process.env) {
  const retries = Number.parseInt(env.HOTVIDEO_DOUBAO_TRANSCRIBE_RETRIES || '', 10);
  const retryDelayMs = Number.parseInt(env.HOTVIDEO_DOUBAO_TRANSCRIBE_RETRY_DELAY_MS || '', 10);
  const timeoutMs = Number.parseInt(env.HOTVIDEO_DOUBAO_TRANSCRIBE_TIMEOUT_MS || '', 10);
  const maxVideoBytes = Number.parseInt(env.HOTVIDEO_DOUBAO_TRANSCRIBE_MAX_VIDEO_BYTES || '', 10);
  return {
    apiKey: env.HOTVIDEO_DOUBAO_API_KEY || env.ARK_API_KEY || readArkKeyFromDotEnv(),
    baseUrl: (env.HOTVIDEO_DOUBAO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.HOTVIDEO_DOUBAO_TRANSCRIBE_MODEL || env.HOTVIDEO_DOUBAO_MODEL || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    retries: Number.isFinite(retries) && retries >= 0 ? retries : 2,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 2500,
    maxVideoBytes: Number.isFinite(maxVideoBytes) && maxVideoBytes > 0
      ? maxVideoBytes
      : DEFAULT_MAX_VIDEO_BYTES,
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
      if (typeof content?.output_text === 'string') parts.push(content.output_text);
    }
  }
  return parts.join('\n').trim();
}

function extractJsonObject(rawText) {
  const text = String(rawText || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Doubao 转写输出不是 JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function normalizeDoubaoVideoCopy(raw) {
  const audioAccess = raw?.audio_access === true;
  const transcript = audioAccess && typeof raw?.audio_transcript === 'string'
    ? raw.audio_transcript.trim()
    : '';
  return {
    full_text: transcript,
    audio_access: audioAccess && transcript.length > 0,
    confidence: typeof raw?.confidence === 'string' ? raw.confidence : '',
  };
}

function buildRequestBody({ model, videoBase64, title }) {
  return {
    model,
    instructions: [
      '你只做短视频音频口播转写。',
      '不要提取画面文字，不要 OCR，不要根据标题或画面猜口播。',
      '没有可辨认人声/旁白/口播时，audio_access 必须为 false，audio_transcript 必须为 null。',
      '只返回一个 JSON 对象。',
    ].join('\n'),
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_video',
          video_url: `data:video/mp4;base64,${videoBase64}`,
          fps: 1,
        },
        {
          type: 'input_text',
          text: [
            '只转写这个视频里的音频口播/旁白。',
            '禁止输出画面 OCR 文案。',
            '返回纯 JSON：{"audio_access":true/false,"audio_transcript":string|null,"confidence":"high|medium|low"}',
            `视频标题：${title || ''}`,
          ].join('\n'),
        },
      ],
    }],
    max_output_tokens: 1200,
  };
}

async function postResponses(body, options) {
  if (!options.apiKey) {
    throw new Error('缺少 ARK_API_KEY 或 HOTVIDEO_DOUBAO_API_KEY');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetch(`${options.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`Doubao 转写失败 HTTP ${res.status}: ${text.slice(0, 500)}`);
      err.retryable = retryable;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function callDoubaoWithRetry(body, options) {
  let lastErr = null;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await postResponses(body, options);
    } catch (err) {
      lastErr = err;
      const retryable = err?.retryable || err?.name === 'AbortError';
      if (!retryable || attempt >= options.retries) break;
      await sleep(options.retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function transcribeVideoCopyWithDoubao(videoDir, meta = {}, opts = {}) {
  const videoPath = resolveVideoPath(videoDir, meta);
  if (!isValidVideoFile(videoPath)) {
    throw new Error(`视频文件不存在或无效: ${videoPath}`);
  }

  const cached = readCachedTranscript(videoDir);
  if (cached) return cached;

  const options = { ...resolveDoubaoVideoCopyOptions(), ...opts };
  const stat = fs.statSync(videoPath);
  if (stat.size > options.maxVideoBytes) {
    throw new Error(`视频过大，Doubao data URL 转写跳过: ${stat.size} > ${options.maxVideoBytes}`);
  }

  const { jsonPath, textPath } = transcriptPaths(videoDir);
  const body = buildRequestBody({
    model: options.model,
    videoBase64: fs.readFileSync(videoPath).toString('base64'),
    title: meta.title,
  });
  const data = await callDoubaoWithRetry(body, options);
  const rawText = extractOutputText(data);
  const parsed = normalizeDoubaoVideoCopy(extractJsonObject(rawText));
  const result = {
    full_text: parsed.full_text,
    audio_access: parsed.audio_access,
    confidence: parsed.confidence,
    runtime: {
      provider: 'doubao',
      model: options.model,
      base_url: options.baseUrl,
    },
  };
  writeJsonAtomic(jsonPath, result);
  fs.writeFileSync(textPath, fullVideoCopyFromTranscript(result), 'utf-8');
  return {
    result,
    fullVideoCopy: fullVideoCopyFromTranscript(result),
    jsonPath,
    textPath,
    cached: false,
  };
}
