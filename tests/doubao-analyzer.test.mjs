import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDoubaoVideoParseFailure,
  isRetryableDoubaoResponse,
  shouldFallbackToFileId,
} from '../pipeline/doubao-analyzer.mjs';

test('豆包视频解析 400 直接切换文件通道，不重复撞 data URL', () => {
  assert.equal(isDoubaoVideoParseFailure(400, 'Error when parsing request'), true);
  assert.equal(isRetryableDoubaoResponse(400, 'Error when parsing request'), false);
  assert.equal(isRetryableDoubaoResponse(400, 'invalid api key'), false);
  assert.equal(isRetryableDoubaoResponse(429, 'rate limited'), true);
  assert.equal(isRetryableDoubaoResponse(503, 'unavailable'), true);
});

test('data URL 连续解析失败后切换 file_id 通道', () => {
  const error = Object.assign(new Error('HTTP 400: Error when parsing request'), { fileFallback: true });
  assert.equal(shouldFallbackToFileId(error, 'data_url'), true);
  assert.equal(shouldFallbackToFileId(error, 'file_id'), false);
  assert.equal(shouldFallbackToFileId(new Error('invalid api key'), 'data_url'), false);
});
