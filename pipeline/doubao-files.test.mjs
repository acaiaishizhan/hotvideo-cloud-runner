import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDoubaoMultipartBody,
  resolveDoubaoFilesOptions,
  uploadWithHttpsMultipart,
  uploadDoubaoVideoFile,
} from './doubao-files.mjs';

function makeVideo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, 'video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 1));
  return videoPath;
}

function fakeHttpsRequest(calls, failures = 0) {
  return (url, requestOptions, onResponse) => {
    const req = new EventEmitter();
    const attempt = calls.length + 1;
    req.destroy = error => queueMicrotask(() => req.emit('error', error));
    req.end = body => {
      calls.push({ url, requestOptions, body });
      req.emit('finish');
      queueMicrotask(() => {
        if (attempt <= failures) {
          const error = new Error(`reset ${attempt}`);
          error.code = 'ECONNRESET';
          req.emit('error', error);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        response.emit('data', Buffer.from(JSON.stringify({ id: 'file_123' })));
        response.emit('end');
        response.emit('close');
      });
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      req.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
    });
    return req;
  };
}

test('resolveDoubaoFilesOptions reads explicit Files API settings', () => {
  const options = resolveDoubaoFilesOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
    HOTVIDEO_DOUBAO_FILES_BASE_URL: 'https://files.test/api/',
    HOTVIDEO_DOUBAO_FILE_UPLOAD_TIMEOUT_MS: '1234',
    HOTVIDEO_DOUBAO_FILE_ACTIVE_TIMEOUT_MS: '5678',
    HOTVIDEO_DOUBAO_FILE_POLL_INTERVAL_MS: '90',
    HOTVIDEO_DOUBAO_FILE_PREPROCESS_FPS: '2',
    HOTVIDEO_DOUBAO_FILE_UPLOAD_TRANSPORT: 'https',
    HOTVIDEO_DOUBAO_FILE_SOCKET_TIMEOUT_MS: '4321',
    HOTVIDEO_DOUBAO_FILE_MAX_ATTEMPTS: '3',
  });

  assert.equal(options.apiKey, 'test-key');
  assert.equal(options.filesBaseUrl, 'https://files.test/api');
  assert.equal(options.uploadTimeoutMs, 1234);
  assert.equal(options.activeTimeoutMs, 5678);
  assert.equal(options.pollIntervalMs, 90);
  assert.equal(options.preprocessFps, 2);
  assert.equal(options.uploadTransport, 'https');
  assert.equal(options.socketTimeoutMs, 4321);
  assert.equal(options.maxAttempts, 3);
});

test('buildDoubaoMultipartBody includes all Files API fields and exact file bytes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, 'video.mp4');
  const video = Buffer.from([0, 1, 2, 3]);
  fs.writeFileSync(videoPath, video);

  const multipart = buildDoubaoMultipartBody(videoPath, { preprocessFps: 2 }, 'test-boundary');
  const text = multipart.body.toString('latin1');
  assert.match(text, /name="purpose"\r\n\r\nuser_data/);
  assert.match(text, /name="preprocess_configs\[video\]\[fps\]"\r\n\r\n2/);
  assert.match(text, /name="file"; filename="video.mp4"/);
  assert.equal(multipart.videoBytes, video.length);
  assert.equal(multipart.body.includes(video), true);
  assert.match(text, /--test-boundary--\r\n$/);
});

test('uploadDoubaoVideoFile selects the https upload adapter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, 'video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 1));
  const calls = [];

  const result = await uploadDoubaoVideoFile(videoPath, {
    apiKey: 'test-key',
    filesBaseUrl: 'https://files.test/api',
    uploadTimeoutMs: 1234,
    activeTimeoutMs: 1000,
    pollIntervalMs: 1,
    preprocessFps: 1,
    uploadTransport: 'https',
    uploadHttpsImpl: async (url, receivedPath, options) => {
      calls.push({ url, receivedPath, timeout: options.uploadTimeoutMs });
      return new Response(JSON.stringify({ id: 'file_123' }), { status: 200 });
    },
  });

  assert.equal(result.fileId, 'file_123');
  assert.deepEqual(calls, [{
    url: 'https://files.test/api/files',
    receivedPath: videoPath,
    timeout: 1234,
  }]);
});

test('https upload 在 socket 创建前覆盖 globalAgent 的 5000ms timeout', async (t) => {
  const videoPath = makeVideo(t);
  const calls = [];
  let agentOptions;
  await uploadWithHttpsMultipart('https://files.test/api/files', videoPath, {
    apiKey: 'test-key',
    preprocessFps: 1,
    uploadTimeoutMs: 4321,
    remainingMs: 4321,
    socketTimeoutMs: 4321,
    httpsAgentFactory: options => {
      agentOptions = options;
      return { destroy() {} };
    },
    httpsRequestImpl: fakeHttpsRequest(calls),
  });
  assert.deepEqual(agentOptions, { timeout: 4321, keepAlive: false });
  assert.equal(calls[0].requestOptions.timeout, 4321);
  assert.notEqual(calls[0].requestOptions.timeout, 5000);
});

test('pre-secureConnect 等待超过 5 秒时只由业务总预算终止', { timeout: 8000 }, async (t) => {
  const videoPath = makeVideo(t);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const port = server.address().port;
  const startedAt = Date.now();
  await assert.rejects(
    uploadWithHttpsMultipart(`https://127.0.0.1:${port}/files`, videoPath, {
      apiKey: 'test-key',
      preprocessFps: 1,
      uploadTimeoutMs: 5300,
      remainingMs: 5300,
      socketTimeoutMs: 10000,
      rejectUnauthorized: false,
    }),
    error => {
      assert.equal(error.timeoutKind, 'wall-clock');
      assert.ok(Date.now() - startedAt >= 5000, `elapsed=${Date.now() - startedAt}`);
      return true;
    },
  );
});

test('TLS 完成但无响应时 inactivity timeout 先于 wall-clock 终止', async (t) => {
  const videoPath = makeVideo(t);
  const requestImpl = () => {
    const req = new EventEmitter();
    req.end = () => {
      req.emit('finish');
      setTimeout(() => req.emit('timeout'), 40);
    };
    req.destroy = error => queueMicrotask(() => req.emit('error', error));
    queueMicrotask(() => {
      const socket = new EventEmitter();
      req.emit('socket', socket);
      socket.emit('connect');
      socket.emit('secureConnect');
    });
    return req;
  };
  await assert.rejects(
    uploadWithHttpsMultipart('https://files.test/api/files', videoPath, {
      apiKey: 'test-key',
      preprocessFps: 1,
      uploadTimeoutMs: 1000,
      remainingMs: 1000,
      socketTimeoutMs: 120,
      httpsRequestImpl: requestImpl,
      httpsAgentFactory: () => ({ destroy() {} }),
    }),
    error => {
      assert.equal(error.timeoutKind, 'inactivity');
      assert.match(error.stage, /upload|response/);
      assert.ok(error.elapsedMs < 900, `elapsed=${error.elapsedMs}`);
      return true;
    },
  );
});

test('retry 共用总 deadline，并为每次 attempt 新建 request/body 且清旧 timer', async (t) => {
  const videoPath = makeVideo(t);
  const calls = [];
  const activeTimers = new Set();
  let destroyedAgents = 0;
  const result = await uploadDoubaoVideoFile(videoPath, {
    apiKey: 'test-key',
    filesBaseUrl: 'https://files.test/api',
    uploadTransport: 'https',
    uploadTimeoutMs: 2000,
    socketTimeoutMs: 1000,
    maxAttempts: 3,
    retryDelayMs: 0,
    preprocessFps: 1,
    httpsRequestImpl: fakeHttpsRequest(calls, 2),
    httpsAgentFactory: () => ({ destroy: () => { destroyedAgents++; } }),
    setTimeoutImpl: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      activeTimers.add(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      clearTimeout(timer);
      activeTimers.delete(timer);
    },
  });
  assert.equal(result.fileId, 'file_123');
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.body)).size, 3);
  assert.equal(destroyedAgents, 3);
  assert.equal(activeTimers.size, 0);
});

test('所有 attempt 和 backoff 共用一次绝对 deadline', async (t) => {
  const videoPath = makeVideo(t);
  let nowMs = 0;
  const remaining = [];
  await assert.rejects(
    uploadDoubaoVideoFile(videoPath, {
      apiKey: 'test-key',
      filesBaseUrl: 'https://files.test/api',
      uploadTransport: 'https',
      uploadTimeoutMs: 1000,
      socketTimeoutMs: 1000,
      maxAttempts: 3,
      retryDelayMs: 100,
      preprocessFps: 1,
      nowImpl: () => nowMs,
      sleepImpl: async ms => { nowMs += ms; },
      uploadHttpsImpl: async (_url, _path, options) => {
        remaining.push(options.remainingMs);
        nowMs += 400;
        const error = new Error(`attempt failed with ${options.remainingMs}ms left`);
        error.code = 'ECONNRESET';
        error.stage = 'upload';
        error.retryable = true;
        throw error;
      },
    }),
    error => {
      assert.equal(error.elapsedMs, 1000);
      assert.equal(error.attempts, 2);
      assert.match(error.cause.message, /1000ms left/);
      assert.equal(error.stage, 'upload');
      return true;
    },
  );
  assert.deepEqual(remaining, [1000, 500]);
});
