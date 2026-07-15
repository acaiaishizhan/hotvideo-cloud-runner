import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableDoubaoResponse } from '../pipeline/doubao-analyzer.mjs';

test('豆包服务端视频解析 400 属于可重试故障', () => {
  assert.equal(isRetryableDoubaoResponse(400, 'Error when parsing request'), true);
  assert.equal(isRetryableDoubaoResponse(400, 'invalid api key'), false);
  assert.equal(isRetryableDoubaoResponse(429, 'rate limited'), true);
  assert.equal(isRetryableDoubaoResponse(503, 'unavailable'), true);
});
