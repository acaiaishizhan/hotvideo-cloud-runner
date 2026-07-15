import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDouyinItemId, videoRecordKey } from './video-url.mjs';

test('videoRecordKey normalizes markdown, canonical and modal Douyin URLs', () => {
  const id = '7650122231460220160';
  assert.equal(videoRecordKey(`https://www.douyin.com/video/${id}`), `douyin:${id}`);
  assert.equal(
    videoRecordKey(`[视频](https://www.douyin.com/video/${id}?previous_page=app_code_link)`),
    `douyin:${id}`,
  );
  assert.equal(videoRecordKey(`https://www.douyin.com/user/foo?modal_id=${id}`), `douyin:${id}`);
  assert.equal(extractDouyinItemId(id), id);
});

test('videoRecordKey keeps a stable trimmed key for non-Douyin URLs', () => {
  assert.equal(videoRecordKey('  https://example.com/video/abc  '), 'url:https://example.com/video/abc');
  assert.equal(videoRecordKey(''), '');
});
