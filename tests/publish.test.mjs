import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadAttachmentWithRetry } from '../pipeline/publish.mjs';

test('附件上传超时后在附件阶段内重试', async () => {
  let calls = 0;
  const result = await uploadAttachmentWithRetry(() => {
    calls++;
    if (calls < 3) throw new Error('server time out error');
    return { ok: true };
  }, {
    attempts: 3,
    delayMs: 0,
    isAccepted: response => response.ok,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempt, 3);
  assert.equal(calls, 3);
});

test('附件重试耗尽会返回失败', async () => {
  const result = await uploadAttachmentWithRetry(() => ({ ok: false }), {
    attempts: 2,
    delayMs: 0,
    isAccepted: response => response.ok,
    responseError: () => 'upload rejected',
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /upload rejected/);
});
