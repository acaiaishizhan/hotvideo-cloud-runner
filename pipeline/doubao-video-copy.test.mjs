import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDoubaoVideoCopy,
  resolveDoubaoVideoCopyOptions,
} from './doubao-video-copy.mjs';

test('normalizeDoubaoVideoCopy keeps spoken transcript only', () => {
  const result = normalizeDoubaoVideoCopy({
    audio_access: true,
    audio_transcript: '  大家好，今天讲 Codex。  ',
    confidence: 'high',
  });

  assert.equal(result.full_text, '大家好，今天讲 Codex。');
  assert.equal(result.audio_access, true);
  assert.equal(result.confidence, 'high');
});

test('normalizeDoubaoVideoCopy leaves empty copy when no speech is available', () => {
  const result = normalizeDoubaoVideoCopy({
    audio_access: false,
    audio_transcript: '画面 OCR 文案不该进入这里',
    confidence: 'medium',
  });

  assert.equal(result.full_text, '');
  assert.equal(result.audio_access, false);
});

test('resolveDoubaoVideoCopyOptions reads explicit API settings from env', () => {
  const options = resolveDoubaoVideoCopyOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
    HOTVIDEO_DOUBAO_BASE_URL: 'https://example.test/api/',
    HOTVIDEO_DOUBAO_TRANSCRIBE_MODEL: 'doubao-test',
    HOTVIDEO_DOUBAO_TRANSCRIBE_TIMEOUT_MS: '1234',
    HOTVIDEO_DOUBAO_TRANSCRIBE_RETRIES: '4',
    HOTVIDEO_DOUBAO_TRANSCRIBE_RETRY_DELAY_MS: '50',
    HOTVIDEO_DOUBAO_TRANSCRIBE_MAX_VIDEO_BYTES: '2048',
  });

  assert.equal(options.apiKey, 'test-key');
  assert.equal(options.baseUrl, 'https://example.test/api');
  assert.equal(options.model, 'doubao-test');
  assert.equal(options.timeoutMs, 1234);
  assert.equal(options.retries, 4);
  assert.equal(options.retryDelayMs, 50);
  assert.equal(options.maxVideoBytes, 2048);
});
