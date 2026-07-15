#!/usr/bin/env node
// ============================================================
//  Doubao Files API helper: large local video -> temporary file_id
// ============================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const DEFAULT_FILES_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_UPLOAD_TIMEOUT_MS = 1800000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_ACTIVE_TIMEOUT_MS = 120000;
const DEFAULT_PREPROCESS_FPS = 1;

function pickFileId(data) {
  return data?.id || data?.data?.id || data?.file?.id || '';
}

function pickFileStatus(data) {
  return String(data?.status || data?.data?.status || data?.file?.status || '').toLowerCase();
}

export function resolveDoubaoFilesOptions(env = process.env) {
  const uploadTimeoutMs = Number.parseInt(env.HOTVIDEO_DOUBAO_FILE_UPLOAD_TIMEOUT_MS || '', 10);
  const activeTimeoutMs = Number.parseInt(env.HOTVIDEO_DOUBAO_FILE_ACTIVE_TIMEOUT_MS || '', 10);
  const pollIntervalMs = Number.parseInt(env.HOTVIDEO_DOUBAO_FILE_POLL_INTERVAL_MS || '', 10);
  const preprocessFps = Number.parseFloat(env.HOTVIDEO_DOUBAO_FILE_PREPROCESS_FPS || '');
  const uploadTransport = (env.HOTVIDEO_DOUBAO_FILE_UPLOAD_TRANSPORT || 'fetch').trim().toLowerCase();
  if (uploadTransport !== 'fetch' && uploadTransport !== 'https') {
    throw new Error(`不支持的 HOTVIDEO_DOUBAO_FILE_UPLOAD_TRANSPORT: ${uploadTransport}`);
  }
  return {
    apiKey: env.HOTVIDEO_DOUBAO_API_KEY || env.ARK_API_KEY || '',
    filesBaseUrl: (env.HOTVIDEO_DOUBAO_FILES_BASE_URL || DEFAULT_FILES_BASE_URL).replace(/\/+$/, ''),
    uploadTransport,
    uploadTimeoutMs: Number.isFinite(uploadTimeoutMs) && uploadTimeoutMs > 0
      ? uploadTimeoutMs
      : DEFAULT_UPLOAD_TIMEOUT_MS,
    activeTimeoutMs: Number.isFinite(activeTimeoutMs) && activeTimeoutMs > 0
      ? activeTimeoutMs
      : DEFAULT_ACTIVE_TIMEOUT_MS,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
      ? pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS,
    preprocessFps: Number.isFinite(preprocessFps) && preprocessFps > 0
      ? preprocessFps
      : DEFAULT_PREPROCESS_FPS,
  };
}

export function buildDoubaoMultipartBody(videoPath, options, boundary = `----hotvideo-${crypto.randomUUID()}`) {
  const video = fs.readFileSync(videoPath);
  const filename = path.basename(videoPath).replace(/["\r\n]/g, '_');
  const prefix = Buffer.from([
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="purpose"\r\n\r\n',
    'user_data\r\n',
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="preprocess_configs[video][fps]"\r\n\r\n',
    `${options.preprocessFps}\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    'Content-Type: video/mp4\r\n\r\n',
  ].join(''), 'utf-8');
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  return {
    body: Buffer.concat([prefix, video, suffix]),
    boundary,
    videoBytes: video.length,
    videoSha256: crypto.createHash('sha256').update(video).digest('hex'),
  };
}

function uploadWithHttpsMultipart(url, videoPath, options) {
  const multipart = buildDoubaoMultipartBody(videoPath, options);
  console.log(`Doubao Files upload digest: ${JSON.stringify({
    transport: 'https',
    videoBytes: multipart.videoBytes,
    videoSha256: multipart.videoSha256,
    contentLength: multipart.body.length,
  })}`);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
        'Content-Length': multipart.body.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
        });
      });
    });
    req.setTimeout(options.uploadTimeoutMs, () => {
      const error = new Error(`Doubao Files 上传超时: ${options.uploadTimeoutMs}ms`);
      error.name = 'AbortError';
      req.destroy(error);
    });
    req.on('error', reject);
    req.end(multipart.body);
  });
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(res, label) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${label} HTTP ${res.status}: ${text.slice(0, 500)}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return data;
}

export async function uploadDoubaoVideoFile(videoPath, opts = {}) {
  const options = { ...resolveDoubaoFilesOptions(), ...opts };
  if (!options.apiKey) {
    throw new Error('缺少 ARK_API_KEY 或 HOTVIDEO_DOUBAO_API_KEY');
  }

  let res;
  if (options.uploadTransport === 'https') {
    const uploadImpl = options.uploadHttpsImpl || uploadWithHttpsMultipart;
    res = await uploadImpl(`${options.filesBaseUrl}/files`, videoPath, options);
  } else {
    const buffer = fs.readFileSync(videoPath);
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('preprocess_configs[video][fps]', String(options.preprocessFps));
    form.append('file', new Blob([buffer], { type: 'video/mp4' }), path.basename(videoPath));
    res = await fetchWithTimeout(`${options.filesBaseUrl}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
    }, options.uploadTimeoutMs);
  }
  const data = await parseJsonResponse(res, 'Doubao Files 上传失败');
  const fileId = pickFileId(data);
  if (!fileId) {
    throw new Error(`Doubao Files 上传未返回 file_id: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return { fileId, data, options };
}

export async function getDoubaoFile(fileId, opts = {}) {
  const options = { ...resolveDoubaoFilesOptions(), ...opts };
  if (!options.apiKey) {
    throw new Error('缺少 ARK_API_KEY 或 HOTVIDEO_DOUBAO_API_KEY');
  }
  const res = await fetchWithTimeout(`${options.filesBaseUrl}/files/${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${options.apiKey}` },
  }, options.uploadTimeoutMs);
  return parseJsonResponse(res, 'Doubao Files 查询失败');
}

export async function waitForDoubaoFileActive(fileId, opts = {}) {
  const options = { ...resolveDoubaoFilesOptions(), ...opts };
  const deadline = Date.now() + options.activeTimeoutMs;
  let lastData = null;
  while (Date.now() <= deadline) {
    lastData = await getDoubaoFile(fileId, options);
    const status = pickFileStatus(lastData);
    if (!status || status === 'active' || status === 'processed' || status === 'success') {
      return lastData;
    }
    if (status === 'failed' || status === 'error' || status === 'deleted') {
      throw new Error(`Doubao Files 处理失败: file_id=${fileId}, status=${status}`);
    }
    await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs));
  }
  throw new Error(`Doubao Files 等待 active 超时: file_id=${fileId}, last=${JSON.stringify(lastData).slice(0, 500)}`);
}

export async function deleteDoubaoFile(fileId, opts = {}) {
  const options = { ...resolveDoubaoFilesOptions(), ...opts };
  if (!options.apiKey) return null;
  const res = await fetchWithTimeout(`${options.filesBaseUrl}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${options.apiKey}` },
  }, options.uploadTimeoutMs);
  return parseJsonResponse(res, 'Doubao Files 删除失败');
}
