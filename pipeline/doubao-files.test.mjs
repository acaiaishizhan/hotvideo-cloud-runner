import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDoubaoMultipartBody,
  resolveDoubaoFilesOptions,
  uploadDoubaoVideoFile,
} from './doubao-files.mjs';

test('resolveDoubaoFilesOptions reads explicit Files API settings', () => {
  const options = resolveDoubaoFilesOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
    HOTVIDEO_DOUBAO_FILES_BASE_URL: 'https://files.test/api/',
    HOTVIDEO_DOUBAO_FILE_UPLOAD_TIMEOUT_MS: '1234',
    HOTVIDEO_DOUBAO_FILE_ACTIVE_TIMEOUT_MS: '5678',
    HOTVIDEO_DOUBAO_FILE_POLL_INTERVAL_MS: '90',
    HOTVIDEO_DOUBAO_FILE_PREPROCESS_FPS: '2',
    HOTVIDEO_DOUBAO_FILE_UPLOAD_TRANSPORT: 'https',
  });

  assert.equal(options.apiKey, 'test-key');
  assert.equal(options.filesBaseUrl, 'https://files.test/api');
  assert.equal(options.uploadTimeoutMs, 1234);
  assert.equal(options.activeTimeoutMs, 5678);
  assert.equal(options.pollIntervalMs, 90);
  assert.equal(options.preprocessFps, 2);
  assert.equal(options.uploadTransport, 'https');
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
