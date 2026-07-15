import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeVideoWithDoubao,
  buildDoubaoAnalyzePrompt,
  buildDoubaoChatBody,
  buildDoubaoRequestDigest,
  extractDoubaoChatJson,
  resolveDoubaoAnalyzerOptions,
} from './doubao-analyzer.mjs';

test('buildDoubaoAnalyzePrompt requires an explicit spoken-audio mark and forbids OCR fallback', () => {
  const prompt = buildDoubaoAnalyzePrompt({
    title: '测试视频',
    scraped: { sourceType: '人文社科/国学', billboards: [{ name: '视频榜' }] },
  });

  assert.match(prompt, /has_spoken_audio 必须明确返回 boolean/);
  assert.match(prompt, /has_spoken_audio=false/);
  assert.match(prompt, /filter_reason="无有效口播"/);
  assert.match(prompt, /full_video_copy 必须是非空的音频口播/);
  assert.match(prompt, /禁止 OCR/);
  assert.match(prompt, /relevant=true 时 filter_reason 必须是空字符串/);
});

test('buildDoubaoChatBody uses chat video_url and json response format', () => {
  const body = buildDoubaoChatBody({
    model: 'doubao-test',
    videoBase64: 'AAAA',
    meta: { title: '测试视频' },
    maxTokens: 1800,
  });

  assert.equal(body.model, 'doubao-test');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[1].content[0].type, 'video_url');
  assert.match(body.messages[1].content[0].video_url.url, /^data:video\/mp4;base64,AAAA/);
});

test('buildDoubaoChatBody accepts Files API file_id video input', () => {
  const body = buildDoubaoChatBody({
    model: 'doubao-test',
    videoUrl: { file_id: 'file_123' },
    meta: { title: '测试视频' },
    maxTokens: 1800,
  });

  assert.deepEqual(body.messages[1].content[0].video_url, { file_id: 'file_123' });
});

test('buildDoubaoRequestDigest reports comparable hashes without exposing video content', () => {
  const body = buildDoubaoChatBody({
    model: 'doubao-test',
    videoBase64: 'AAAA',
    meta: { title: '测试视频' },
    maxTokens: 1800,
  });
  const digest = buildDoubaoRequestDigest(body, {
    inputMode: 'data_url',
    httpTransport: 'https',
    videoBytes: 3,
    videoSha256: 'video-sha',
  });

  assert.equal(digest.videoInput, 'data_url');
  assert.equal(digest.httpTransport, 'https');
  assert.equal(digest.videoBytes, 3);
  assert.equal(digest.videoSha256, 'video-sha');
  assert.equal(digest.payloadSha256.length, 64);
  assert.ok(digest.payloadBytes > 0);
  assert.equal(JSON.stringify(digest).includes('AAAA'), false);
});

test('extractDoubaoChatJson parses fenced and plain JSON content', () => {
  const parsed = extractDoubaoChatJson({
    choices: [{ message: { content: '```json\n{"relevant":true,"full_video_copy":""}\n```' } }],
  });

  assert.equal(parsed.relevant, true);
  assert.equal(parsed.full_video_copy, '');
});

test('resolveDoubaoAnalyzerOptions reads explicit env settings', () => {
  const options = resolveDoubaoAnalyzerOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
    HOTVIDEO_DOUBAO_BASE_URL: 'https://example.test/api/',
    HOTVIDEO_DOUBAO_ANALYZE_MODEL: 'doubao-test',
    HOTVIDEO_DOUBAO_HTTP_TRANSPORT: 'fetch',
    HOTVIDEO_DOUBAO_ANALYZE_TIMEOUT_MS: '1234',
    HOTVIDEO_DOUBAO_ANALYZE_RETRIES: '4',
    HOTVIDEO_DOUBAO_ANALYZE_RETRY_DELAY_MS: '50',
    HOTVIDEO_DOUBAO_ANALYZE_MAX_VIDEO_BYTES: '2048',
    HOTVIDEO_DOUBAO_ANALYZE_MAX_TOKENS: '900',
  });

  assert.equal(options.apiKey, 'test-key');
  assert.equal(options.baseUrl, 'https://example.test/api');
  assert.equal(options.model, 'doubao-test');
  assert.equal(options.transport, 'fetch');
  assert.equal(options.timeoutMs, 1234);
  assert.equal(options.retries, 4);
  assert.equal(options.retryDelayMs, 50);
  assert.equal(options.maxVideoBytes, 2048);
  assert.equal(options.maxTokens, 900);
});

test('resolveDoubaoAnalyzerOptions uses bounded fast-lane requests without inline retries', () => {
  const options = resolveDoubaoAnalyzerOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
  });

  assert.equal(options.timeoutMs, 360000);
  assert.equal(options.retries, 0);
  assert.equal(options.transport, 'https');
});

test('resolveDoubaoAnalyzerOptions keeps a longer timeout for the slow lane', () => {
  const options = resolveDoubaoAnalyzerOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
    HOTVIDEO_ANALYZE_LANE: 'slow',
  });

  assert.equal(options.timeoutMs, 900000);
  assert.equal(options.retries, 0);
});

test('analyzeVideoWithDoubao uploads oversized videos through Files API and cleans up', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-doubao-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, 'video.mp4'), Buffer.alloc(2048, 1));

  const calls = [];
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (String(url) === 'https://files.test/files' && init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'file_123', status: 'uploaded' }), { status: 200 });
    }
    if (String(url) === 'https://files.test/files/file_123' && init.method === 'GET') {
      return new Response(JSON.stringify({ id: 'file_123', status: 'active' }), { status: 200 });
    }
    if (String(url) === 'https://chat.test/chat/completions' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.messages[1].content[0].video_url, { file_id: 'file_123' });
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              relevant: true,
              summary: '测试摘要',
              content_type: '工具教程',
              topics: ['AI编程'],
              tags: ['测试'],
              hook: '',
              viral_reason: '',
              imitation_angle: '',
              read_evidence: '听到测试口播',
              full_video_copy: '测试口播',
            }),
          },
        }],
      }), { status: 200 });
    }
    if (String(url) === 'https://files.test/files/file_123' && init.method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${init.method} ${url}`);
  };

  const output = await analyzeVideoWithDoubao(tempDir, { title: '大视频' }, {
    apiKey: 'test-key',
    baseUrl: 'https://chat.test',
    fetchImpl: globalThis.fetch,
    model: 'doubao-test',
    maxVideoBytes: 1024,
    maxTokens: 900,
    timeoutMs: 1000,
    retries: 0,
    files: {
      apiKey: 'test-key',
      filesBaseUrl: 'https://files.test',
      uploadTimeoutMs: 1000,
      activeTimeoutMs: 1000,
      pollIntervalMs: 1,
      preprocessFps: 1,
    },
  });

  assert.equal(output.result.full_video_copy, '测试口播');
  assert.equal(output.runtime.videoInput, 'file_id');
  assert.equal(output.runtime.fileId, 'file_123');
  assert.deepEqual(
    calls.map(call => `${call.method} ${call.url}`),
    [
      'POST https://files.test/files',
      'GET https://files.test/files/file_123',
      'POST https://chat.test/chat/completions',
      'DELETE https://files.test/files/file_123',
    ],
  );
});

test('analyzeVideoWithDoubao deletes uploaded file when waiting for active fails', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-doubao-wait-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, 'video.mp4'), Buffer.alloc(2048, 1));

  const calls = [];
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method} ${url}`);
    if (String(url) === 'https://files.test/files' && init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'file_wait_fail', status: 'uploaded' }), { status: 200 });
    }
    if (String(url) === 'https://files.test/files/file_wait_fail' && init.method === 'GET') {
      return new Response(JSON.stringify({ id: 'file_wait_fail', status: 'failed' }), { status: 200 });
    }
    if (String(url) === 'https://files.test/files/file_wait_fail' && init.method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${init.method} ${url}`);
  };

  await assert.rejects(
    analyzeVideoWithDoubao(tempDir, { title: '等待失败的大视频' }, {
      apiKey: 'test-key',
      baseUrl: 'https://chat.test',
      model: 'doubao-test',
      maxVideoBytes: 1024,
      maxTokens: 900,
      timeoutMs: 1000,
      retries: 0,
      files: {
        apiKey: 'test-key',
        filesBaseUrl: 'https://files.test',
        uploadTimeoutMs: 1000,
        activeTimeoutMs: 1000,
        pollIntervalMs: 1,
        preprocessFps: 1,
      },
    }),
    /Files 处理失败/,
  );

  assert.deepEqual(calls, [
    'POST https://files.test/files',
    'GET https://files.test/files/file_wait_fail',
    'DELETE https://files.test/files/file_wait_fail',
  ]);
});

test('analyzeVideoWithDoubao retries once with a larger output budget after length truncation', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-doubao-length-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, 'video.mp4'), Buffer.alloc(2048, 1));

  const maxTokensSeen = [];
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), 'https://chat.test/chat/completions');
    const body = JSON.parse(init.body);
    maxTokensSeen.push(body.max_tokens);
    if (maxTokensSeen.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '{"relevant":true' } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ relevant: true, full_video_copy: '完整口播' }) },
      }],
    }), { status: 200 });
  };

  const output = await analyzeVideoWithDoubao(tempDir, { title: '长视频' }, {
    apiKey: 'test-key',
    baseUrl: 'https://chat.test',
    fetchImpl: globalThis.fetch,
    model: 'doubao-test',
    maxVideoBytes: 4096,
    maxTokens: 1800,
    lengthRetryMaxTokens: 7200,
    timeoutMs: 1000,
    retries: 0,
  });

  assert.deepEqual(maxTokensSeen, [1800, 7200]);
  assert.equal(output.result.full_video_copy, '完整口播');
  assert.equal(output.runtime.lengthRetried, true);
});

test('analyzeVideoWithDoubao retries malformed JSON once with a larger output budget', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-doubao-json-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, 'video.mp4'), Buffer.alloc(2048, 1));

  const maxTokensSeen = [];
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), 'https://chat.test/chat/completions');
    const body = JSON.parse(init.body);
    maxTokensSeen.push(body.max_tokens);
    if (maxTokensSeen.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '这不是 JSON' } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ relevant: true, full_video_copy: '重试后的完整口播' }) },
      }],
    }), { status: 200 });
  };

  const output = await analyzeVideoWithDoubao(tempDir, { title: '非 JSON 视频' }, {
    apiKey: 'test-key',
    baseUrl: 'https://chat.test',
    fetchImpl: globalThis.fetch,
    model: 'doubao-test',
    maxVideoBytes: 4096,
    maxTokens: 1800,
    lengthRetryMaxTokens: 7200,
    timeoutMs: 1000,
    retries: 0,
  });

  assert.deepEqual(maxTokensSeen, [1800, 7200]);
  assert.equal(output.result.full_video_copy, '重试后的完整口播');
  assert.equal(output.runtime.jsonRetried, true);
});
