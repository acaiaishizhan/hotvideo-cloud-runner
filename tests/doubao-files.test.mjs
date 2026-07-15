import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRetryableDoubaoOperationError,
  retryDoubaoOperation,
} from '../pipeline/doubao-files.mjs';

test('Files API 网络断连属于可重试错误', () => {
  assert.equal(isRetryableDoubaoOperationError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableDoubaoOperationError(new TypeError('fetch failed')), true);
  assert.equal(isRetryableDoubaoOperationError(new Error('invalid api key')), false);
});

test('Files API 操作在网络恢复后成功', async () => {
  let calls = 0;
  const result = await retryDoubaoOperation(async () => {
    calls++;
    if (calls < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, { operationRetries: 2, retryDelayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});
