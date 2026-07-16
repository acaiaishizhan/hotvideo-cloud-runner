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
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

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
  const socketTimeoutMs = Number.parseInt(env.HOTVIDEO_DOUBAO_FILE_SOCKET_TIMEOUT_MS || '', 10);
  const maxAttempts = Number.parseInt(env.HOTVIDEO_DOUBAO_FILE_MAX_ATTEMPTS || '', 10);
  const retryDelayMs = Number.parseInt(env.HOTVIDEO_DOUBAO_FILE_RETRY_DELAY_MS || '', 10);
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
    socketTimeoutMs: Number.isFinite(socketTimeoutMs) && socketTimeoutMs > 0
      ? socketTimeoutMs
      : (Number.isFinite(uploadTimeoutMs) && uploadTimeoutMs > 0 ? uploadTimeoutMs : DEFAULT_UPLOAD_TIMEOUT_MS),
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0
      ? maxAttempts
      : DEFAULT_MAX_ATTEMPTS,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0
      ? retryDelayMs
      : DEFAULT_RETRY_DELAY_MS,
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

function uploadError(message, details = {}) {
  const error = new Error(message, details.cause ? { cause: details.cause } : undefined);
  Object.assign(error, details);
  return error;
}

function parseUploadResponse(status, text, startedAt, now) {
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw uploadError(`Doubao Files 上传响应不是 JSON: ${text.slice(0, 500)}`, {
      stage: 'response',
      elapsedMs: now() - startedAt,
      retryable: false,
      orphanPossible: status >= 200 && status < 300,
    });
  }
  if (status < 200 || status >= 300) {
    throw uploadError(`Doubao Files 上传失败 HTTP ${status}: ${text.slice(0, 500)}`, {
      stage: 'response',
      elapsedMs: now() - startedAt,
      retryable: status === 429 || status >= 500,
      orphanPossible: false,
    });
  }
  if (!pickFileId(data)) {
    throw uploadError(`Doubao Files 上传未返回 file_id: ${JSON.stringify(data).slice(0, 500)}`, {
      stage: 'response',
      elapsedMs: now() - startedAt,
      retryable: false,
      orphanPossible: true,
    });
  }
  return data;
}

function isRetryableUploadError(error) {
  return error?.retryable === true
    || error?.name === 'AbortError'
    || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error?.code);
}

function terminalUploadError(firstError, lastError, startedAt, now, attempts, orphanPossible) {
  lastError ||= firstError;
  const elapsedMs = now() - startedAt;
  const lastPart = lastError !== firstError ? `; last=${lastError.message}` : '';
  return uploadError(
    `Doubao Files 上传失败: first=${firstError.message}${lastPart}; elapsed=${elapsedMs}ms; stage=${firstError.stage || 'upload'}`,
    {
      cause: firstError,
      code: firstError.code,
      stage: firstError.stage || 'upload',
      elapsedMs,
      attempts,
      retryable: isRetryableUploadError(lastError),
      orphanPossible,
    },
  );
}

export function uploadWithHttpsMultipart(url, videoPath, options) {
  const multipartFactory = options.multipartFactory || buildDoubaoMultipartBody;
  const multipart = multipartFactory(videoPath, options);
  const now = options.nowImpl || Date.now;
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  const startedAt = now();
  const remainingMs = Math.max(1, options.remainingMs || options.uploadTimeoutMs);
  const socketTimeoutMs = Math.max(1, Math.min(options.socketTimeoutMs || remainingMs, remainingMs));
  const agentOptions = { timeout: socketTimeoutMs, keepAlive: false };
  const agent = options.httpsAgentFactory
    ? options.httpsAgentFactory(agentOptions)
    : new https.Agent(agentOptions);
  const requestImpl = options.httpsRequestImpl || https.request;
  console.log(`Doubao Files upload digest: ${JSON.stringify({
    transport: 'https',
    videoBytes: multipart.videoBytes,
    videoSha256: multipart.videoSha256,
    contentLength: multipart.body.length,
  })}`);
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let settled = false;
    let responseEnded = false;
    let stage = 'connect';

    const cleanup = () => {
      clearTimer(wallTimer);
      req?.removeListener('timeout', onRequestTimeout);
      req?.removeListener('error', onRequestError);
      req?.removeListener('finish', onRequestFinish);
      response?.removeListener('error', onResponseError);
      response?.removeListener('aborted', onResponseAborted);
      response?.removeListener('close', onResponseClose);
      agent?.destroy?.();
    };
    const settle = (error, data) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        if (!error.stage) error.stage = stage;
        if (!Number.isFinite(error.elapsedMs)) error.elapsedMs = now() - startedAt;
        if (typeof error.retryable !== 'boolean') error.retryable = isRetryableUploadError(error);
        if (typeof error.orphanPossible !== 'boolean') {
          error.orphanPossible = stage === 'upload' || stage === 'response';
        }
        reject(error);
      } else {
        resolve(data);
      }
    };
    const timeoutError = (kind) => uploadError(
      `Doubao Files 上传${kind === 'wall-clock' ? '总预算' : '连接/传输无活动'}超时: elapsed=${now() - startedAt}ms, stage=${stage}`,
      {
        code: 'ETIMEDOUT',
        name: 'AbortError',
        timeoutKind: kind,
        stage,
        retryable: true,
        orphanPossible: stage === 'upload' || stage === 'response',
      },
    );
    const onRequestTimeout = () => req?.destroy(timeoutError('inactivity'));
    const onRequestError = error => settle(error);
    const onRequestFinish = () => { stage = 'response'; };
    const onResponseError = error => settle(error);
    const onResponseAborted = () => settle(uploadError('Doubao Files 上传响应被中止', {
      code: 'ECONNRESET',
      retryable: true,
      stage: 'response',
      orphanPossible: true,
    }));
    const onResponseClose = () => {
      if (!responseEnded) onResponseAborted();
    };
    const wallTimer = setTimer(() => req?.destroy(timeoutError('wall-clock')), remainingMs);

    try {
      req = requestImpl(url, {
        method: 'POST',
        agent,
        timeout: socketTimeoutMs,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
          'Content-Length': multipart.body.length,
        },
        ...(options.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
      }, res => {
        response = res;
        stage = 'response';
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.once('error', onResponseError);
        res.once('aborted', onResponseAborted);
        res.once('close', onResponseClose);
        res.once('end', () => {
          responseEnded = true;
          try {
            const text = Buffer.concat(chunks).toString('utf-8');
            settle(null, parseUploadResponse(res.statusCode || 0, text, startedAt, now));
          } catch (error) {
            settle(error);
          }
        });
      });
      req.once('socket', socket => {
        socket.once('connect', () => { stage = 'tls'; });
        socket.once('secureConnect', () => { stage = 'upload'; });
      });
      req.once('timeout', onRequestTimeout);
      req.once('error', onRequestError);
      req.once('finish', onRequestFinish);
      req.end(multipart.body);
    } catch (error) {
      settle(error);
    }
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

  const now = options.nowImpl || Date.now;
  const sleep = options.sleepImpl || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const startedAt = now();
  const deadline = startedAt + options.uploadTimeoutMs;
  let firstError;
  let lastError;
  let orphanPossible = false;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    attemptsMade = attempt;
    try {
      let data;
      if (options.uploadTransport === 'https') {
        const uploadImpl = options.uploadHttpsImpl || uploadWithHttpsMultipart;
        const result = await uploadImpl(`${options.filesBaseUrl}/files`, videoPath, {
          ...options,
          attempt,
          remainingMs,
        });
        data = result && typeof result.text === 'function'
          ? await parseJsonResponse(result, 'Doubao Files 上传失败')
          : result;
      } else {
        const buffer = fs.readFileSync(videoPath);
        const form = new FormData();
        form.append('purpose', 'user_data');
        form.append('preprocess_configs[video][fps]', String(options.preprocessFps));
        form.append('file', new Blob([buffer], { type: 'video/mp4' }), path.basename(videoPath));
        const res = await fetchWithTimeout(`${options.filesBaseUrl}/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}` },
          body: form,
        }, remainingMs);
        data = await parseJsonResponse(res, 'Doubao Files 上传失败');
      }
      const fileId = pickFileId(data);
      if (!fileId) {
        throw uploadError(`Doubao Files 上传未返回 file_id: ${JSON.stringify(data).slice(0, 500)}`, {
          stage: 'response',
          retryable: false,
          orphanPossible: true,
        });
      }
      return { fileId, data, options };
    } catch (error) {
      if (!error.stage) error.stage = 'upload';
      if (!Number.isFinite(error.elapsedMs)) error.elapsedMs = now() - startedAt;
      if (typeof error.orphanPossible !== 'boolean') error.orphanPossible = error.stage !== 'connect' && error.stage !== 'tls';
      firstError ||= error;
      lastError = error;
      orphanPossible ||= error.orphanPossible;
      if (!isRetryableUploadError(error) || attempt >= options.maxAttempts) {
        throw terminalUploadError(firstError, lastError, startedAt, now, attempt, orphanPossible);
      }
      const backoffMs = Math.min(options.retryDelayMs * (2 ** (attempt - 1)), deadline - now());
      if (deadline - now() <= 0) break;
      if (backoffMs > 0) await sleep(backoffMs);
    }
  }
  throw terminalUploadError(
    firstError || uploadError('Doubao Files 上传总预算已耗尽', {
      code: 'ETIMEDOUT',
      stage: 'connect',
      retryable: true,
      orphanPossible,
    }),
    lastError || firstError,
    startedAt,
    now,
    attemptsMade,
    orphanPossible,
  );
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
