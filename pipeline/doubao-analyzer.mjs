#!/usr/bin/env node
// ============================================================
//  Doubao 单次视频分析：video.mp4 -> analysis JSON
//  走火山 Coding Plan chat/completions；一次完成口播转写 + 内容审查。
// ============================================================

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildSystemPromptForMeta, CONTENT_TYPES, TOPICS } from './prompt.mjs';
import { isValidVideoFile, resolveVideoPath } from './video-file.mjs';
import {
  deleteDoubaoFile,
  resolveDoubaoFilesOptions,
  uploadDoubaoVideoFile,
  waitForDoubaoFileActive,
} from './doubao-files.mjs';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const DEFAULT_MODEL = 'doubao-seed-2.0-pro';
const DEFAULT_FAST_TIMEOUT_MS = 360000;
const DEFAULT_SLOW_TIMEOUT_MS = 900000;
const DEFAULT_MAX_VIDEO_BYTES = 32 * 1024 * 1024;

function readArkKeyFromDotEnv() {
  const envPath = path.join(WORKSPACE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return '';
  const text = fs.readFileSync(envPath, 'utf-8');
  const line = text.split(/\r?\n/).find(item => item.startsWith('ARK_API_KEY='));
  if (!line) return '';
  return line.split('=', 2)[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
}

export function resolveDoubaoAnalyzerOptions(env = process.env) {
  const retries = Number.parseInt(env.HOTVIDEO_DOUBAO_ANALYZE_RETRIES || '', 10);
  const retryDelayMs = Number.parseInt(env.HOTVIDEO_DOUBAO_ANALYZE_RETRY_DELAY_MS || '', 10);
  const timeoutMs = Number.parseInt(env.HOTVIDEO_DOUBAO_ANALYZE_TIMEOUT_MS || '', 10);
  const maxVideoBytes = Number.parseInt(env.HOTVIDEO_DOUBAO_ANALYZE_MAX_VIDEO_BYTES || '', 10);
  const maxTokens = Number.parseInt(env.HOTVIDEO_DOUBAO_ANALYZE_MAX_TOKENS || '', 10);
  const lengthRetryMaxTokens = Number.parseInt(
    env.HOTVIDEO_DOUBAO_ANALYZE_LENGTH_RETRY_MAX_TOKENS || '',
    10,
  );
  const lane = (env.HOTVIDEO_ANALYZE_LANE || 'fast').trim().toLowerCase();
  const defaultTimeoutMs = lane === 'slow' || lane === 'all'
    ? DEFAULT_SLOW_TIMEOUT_MS
    : DEFAULT_FAST_TIMEOUT_MS;
  return {
    apiKey: env.HOTVIDEO_DOUBAO_API_KEY || env.ARK_API_KEY || readArkKeyFromDotEnv(),
    baseUrl: (env.HOTVIDEO_DOUBAO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.HOTVIDEO_DOUBAO_ANALYZE_MODEL || env.HOTVIDEO_DOUBAO_MODEL || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    retries: Number.isFinite(retries) && retries >= 0 ? retries : 0,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 2500,
    maxVideoBytes: Number.isFinite(maxVideoBytes) && maxVideoBytes > 0
      ? maxVideoBytes
      : DEFAULT_MAX_VIDEO_BYTES,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1800,
    lengthRetryMaxTokens: Number.isFinite(lengthRetryMaxTokens) && lengthRetryMaxTokens > 0
      ? lengthRetryMaxTokens
      : 7200,
    files: resolveDoubaoFilesOptions({
      ...env,
      HOTVIDEO_DOUBAO_API_KEY: env.HOTVIDEO_DOUBAO_API_KEY || env.ARK_API_KEY || readArkKeyFromDotEnv(),
    }),
  };
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function formatDuration(sec) {
  const totalSec = Math.round(sec || 0);
  const min = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function readMetaFields(meta = {}) {
  const scraped = meta.scraped || {};
  const billboards = scraped.billboards || meta.billboards || [];
  const author = typeof meta.author === 'object' && meta.author !== null
    ? meta.author.name || ''
    : (meta.author || '');
  const view = firstPositiveNumber(
    meta.stats?.viewCount,
    meta.metrics?.play_count,
    meta.metrics?.playCount,
    scraped.playCount,
    scraped.play_count,
  );
  const like = firstPositiveNumber(
    meta.stats?.likeCount,
    meta.metrics?.like_count,
    meta.metrics?.likeCount,
    scraped.likeCount,
    scraped.like_count,
  );
  const durationSec = meta.durationSec
    ?? (typeof meta.duration === 'number' ? Math.round(meta.duration / 1000) : 0);
  return {
    title: meta.title || '',
    author,
    view,
    like,
    durationText: formatDuration(durationSec),
    billboards: billboards.map(b => b.name).join('、') || '无',
    sourceType: String(scraped.sourceType || meta.sourceType || ''),
  };
}

export function buildDoubaoAnalyzePrompt(meta = {}) {
  const m = readMetaFields(meta);
  return [
    '一次完成视频审查。只返回紧凑合法 JSON。',
    `元数据：标题=${m.title}；作者=${m.author}；播放量=${m.view}；点赞数=${m.like}；时长=${m.durationText}；上榜=${m.billboards}；sourceType=${m.sourceType}`,
    '规则：',
    '1 has_spoken_audio 必须明确返回 boolean。能听到承载内容的人声口播/旁白才为 true；只有背景音乐、音效、静音或画面文字时为 false。',
    '2 has_spoken_audio=false 时，必须同时返回 relevant=false、filter_reason="无有效口播"、full_video_copy=""。',
    '3 has_spoken_audio=true 时，full_video_copy 必须是非空的音频口播逐字转写；禁止 OCR/标题/标签/画面文字。',
    '4 relevant=true 时 filter_reason 必须是空字符串。',
    '5 relevant=false 后也要填 summary/content_type/topics/tags/hook/viral_reason/imitation_angle/read_evidence。',
    '6 AI/科技/国学社科有知识、观点、案例、教程价值则 true；纯玄学祈福、纯鸡汤、纯展示、纯娱乐、带货引流则 false。',
    `字段：has_spoken_audio(boolean),relevant(boolean),filter_reason(string),summary(string<=30字),content_type(one of ${CONTENT_TYPES.join('|')}),topics(array 1-3 of ${TOPICS.join('|')}),tags(array 3-5 string),hook(string),viral_reason(string),imitation_angle(string),read_evidence(string),full_video_copy(string)。`,
  ].join('\n');
}

function extractJsonObject(rawText) {
  const text = String(rawText || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Doubao 分析输出不是 JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function extractDoubaoChatJson(data) {
  const text = data?.choices?.[0]?.message?.content || '';
  return extractJsonObject(text);
}

export function buildDoubaoChatBody({ model, videoBase64, videoUrl, meta, maxTokens }) {
  const resolvedVideoUrl = videoUrl || { url: `data:video/mp4;base64,${videoBase64}` };
  return {
    model,
    messages: [
      {
        role: 'system',
        content: [
          buildSystemPromptForMeta(meta),
          '你是短视频内容审查员。输出必须是合法 JSON，不要解释，不要 markdown。',
          '必须明确返回 has_spoken_audio；无有效口播的视频直接标记为 false。',
          'full_video_copy 只能写音频口播；不要用 OCR、标题、标签或画面文字补文案。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          {
            type: 'video_url',
            video_url: resolvedVideoUrl,
          },
          {
            type: 'text',
            text: buildDoubaoAnalyzePrompt(meta),
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
    temperature: 0,
  };
}

function requestChatCompletions(url, body, options) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        text: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.setTimeout(options.timeoutMs, () => {
      const err = new Error(`Doubao 分析超时: ${options.timeoutMs}ms`);
      err.name = 'AbortError';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function postChatCompletions(body, options) {
  if (!options.apiKey) {
    throw new Error('缺少 ARK_API_KEY 或 HOTVIDEO_DOUBAO_API_KEY');
  }
  if (options.fetchImpl) {
    const res = await options.fetchImpl(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = isRetryableDoubaoResponse(res.status, text);
      const err = new Error(`Doubao 分析失败 HTTP ${res.status}: ${text.slice(0, 500)}`);
      err.retryable = retryable;
      err.fileFallback = isDoubaoVideoParseFailure(res.status, text);
      throw err;
    }
    return JSON.parse(text);
  }
  const response = await requestChatCompletions(`${options.baseUrl}/chat/completions`, body, options);
  if (response.status < 200 || response.status >= 300) {
    const retryable = isRetryableDoubaoResponse(response.status, response.text);
    const err = new Error(`Doubao 分析失败 HTTP ${response.status}: ${response.text.slice(0, 500)}`);
    err.retryable = retryable;
    err.fileFallback = isDoubaoVideoParseFailure(response.status, response.text);
    throw err;
  }
  return JSON.parse(response.text);
}

export function isRetryableDoubaoResponse(status, text = '') {
  return status === 429 || status >= 500;
}

export function isDoubaoVideoParseFailure(status, text = '') {
  return status === 400 && /error when parsing request/i.test(String(text));
}

async function callDoubaoWithRetry(body, options) {
  let lastErr = null;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await postChatCompletions(body, options);
    } catch (err) {
      lastErr = err;
      const retryable = err?.retryable || err?.name === 'AbortError';
      if (!retryable || attempt >= options.retries) break;
      await sleep(options.retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

async function buildVideoUrlForChat(videoPath, stat, options) {
  if (stat.size <= options.maxVideoBytes) {
    return {
      videoUrl: { url: `data:video/mp4;base64,${fs.readFileSync(videoPath).toString('base64')}` },
      uploadedFileId: '',
      inputMode: 'data_url',
    };
  }

  return uploadVideoForChat(videoPath, options);
}

async function uploadVideoForChat(videoPath, options) {
  const uploaded = await uploadDoubaoVideoFile(videoPath, {
    ...options.files,
    apiKey: options.apiKey,
  });
  try {
    await waitForDoubaoFileActive(uploaded.fileId, {
      ...options.files,
      apiKey: options.apiKey,
    });
  } catch (err) {
    try {
      await deleteDoubaoFile(uploaded.fileId, {
        ...options.files,
        apiKey: options.apiKey,
      });
    } catch (cleanupErr) {
      console.warn(`Doubao Files 删除失败，需后续清理 file_id=${uploaded.fileId}: ${cleanupErr.message}`);
    }
    throw err;
  }
  return {
    videoUrl: { file_id: uploaded.fileId },
    uploadedFileId: uploaded.fileId,
    inputMode: 'file_id',
  };
}

export function shouldFallbackToFileId(error, inputMode) {
  return inputMode === 'data_url'
    && (error?.fileFallback === true
      || /error when parsing request/i.test(String(error?.message || '')));
}

export async function analyzeVideoWithDoubao(videoDir, meta = {}, opts = {}) {
  const videoPath = resolveVideoPath(videoDir, meta);
  if (!isValidVideoFile(videoPath)) {
    throw new Error(`视频文件不存在或无效: ${videoPath}`);
  }

  const options = { ...resolveDoubaoAnalyzerOptions(), ...opts };
  const stat = fs.statSync(videoPath);
  let input = await buildVideoUrlForChat(videoPath, stat, options);
  try {
    let body = buildDoubaoChatBody({
      model: options.model,
      videoUrl: input.videoUrl,
      meta,
      maxTokens: options.maxTokens,
    });
    let data;
    try {
      data = await callDoubaoWithRetry(body, options);
    } catch (error) {
      if (!shouldFallbackToFileId(error, input.inputMode)) throw error;
      input = await uploadVideoForChat(videoPath, options);
      body = buildDoubaoChatBody({
        model: options.model,
        videoUrl: input.videoUrl,
        meta,
        maxTokens: options.maxTokens,
      });
      data = await callDoubaoWithRetry(body, options);
    }
    let lengthRetried = false;
    if (data?.choices?.[0]?.finish_reason === 'length') {
      lengthRetried = true;
      data = await callDoubaoWithRetry({
        ...body,
        max_tokens: Math.max(options.lengthRetryMaxTokens, options.maxTokens * 4),
      }, options);
    }
    let jsonRetried = false;
    let parsed;
    try {
      parsed = extractDoubaoChatJson(data);
    } catch {
      jsonRetried = true;
      data = await callDoubaoWithRetry({
        ...body,
        max_tokens: Math.max(options.lengthRetryMaxTokens, options.maxTokens * 4),
      }, options);
      parsed = extractDoubaoChatJson(data);
    }
    return {
      result: parsed,
      runtime: {
        provider: 'doubao',
        model: options.model,
        baseUrl: options.baseUrl,
        finishReason: data?.choices?.[0]?.finish_reason || '',
        videoInput: input.inputMode,
        fileId: input.uploadedFileId,
        lengthRetried,
        jsonRetried,
      },
    };
  } finally {
    if (input.uploadedFileId) {
      try {
        await deleteDoubaoFile(input.uploadedFileId, {
          ...options.files,
          apiKey: options.apiKey,
        });
      } catch (err) {
        console.warn(`Doubao Files 删除失败，需后续清理 file_id=${input.uploadedFileId}: ${err.message}`);
      }
    }
  }
}
