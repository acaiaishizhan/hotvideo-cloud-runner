import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDoubaoFilesOptions } from './doubao-files.mjs';

test('resolveDoubaoFilesOptions reads explicit Files API settings', () => {
  const options = resolveDoubaoFilesOptions({
    HOTVIDEO_DOUBAO_API_KEY: 'test-key',
    HOTVIDEO_DOUBAO_FILES_BASE_URL: 'https://files.test/api/',
    HOTVIDEO_DOUBAO_FILE_UPLOAD_TIMEOUT_MS: '1234',
    HOTVIDEO_DOUBAO_FILE_ACTIVE_TIMEOUT_MS: '5678',
    HOTVIDEO_DOUBAO_FILE_POLL_INTERVAL_MS: '90',
    HOTVIDEO_DOUBAO_FILE_PREPROCESS_FPS: '2',
  });

  assert.equal(options.apiKey, 'test-key');
  assert.equal(options.filesBaseUrl, 'https://files.test/api');
  assert.equal(options.uploadTimeoutMs, 1234);
  assert.equal(options.activeTimeoutMs, 5678);
  assert.equal(options.pollIntervalMs, 90);
  assert.equal(options.preprocessFps, 2);
});
