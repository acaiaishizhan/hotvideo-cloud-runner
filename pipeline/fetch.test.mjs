import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFilteredMeta,
  isTerminalFetchError,
  isTerminalDownloadResult,
  shouldRetryExistingMeta,
  updatePendingAfterFetch,
} from './fetch.mjs';

test('isTerminalDownloadResult treats image/audio posts as non-video terminal failures', () => {
  assert.equal(isTerminalDownloadResult({
    media: { directUrl: 'https://example.com/audio.mp3' },
  }), true);

  assert.equal(isTerminalDownloadResult({
    raw: { item: { aweme_type: 2, images: [{ uri: 'cover' }] } },
  }), true);

  assert.equal(isTerminalDownloadResult({
    media: { directUrl: 'https://example.com/video.mp4' },
    raw: { item: { aweme_type: 0 } },
  }), false);
});

test('isTerminalFetchError classifies unextractable Douyin candidates as terminal only', () => {
  assert.equal(isTerminalFetchError('无法从分享页提取视频信息'), false);
  assert.equal(isTerminalFetchError(new Error('video unavailable')), true);
  assert.equal(isTerminalFetchError('network timeout while downloading'), false);
  assert.equal(isTerminalFetchError('HTTP 503 Service Unavailable'), false);
});

test('shouldRetryExistingMeta retries old share-page extraction false positives only', () => {
  assert.equal(shouldRetryExistingMeta({
    status: 'filtered',
    analysis: { filter_reason: '下载阶段判定不可解析，跳过重试: 无法从分享页提取视频信息' },
  }), true);

  assert.equal(shouldRetryExistingMeta({
    status: 'filtered',
    analysis: { filter_reason: '非标准视频内容，video-infra 未产出有效 video.mp4' },
  }), false);

  assert.equal(shouldRetryExistingMeta({ status: 'published' }), false);
});

test('updatePendingAfterFetch removes completed items and escalates repeated failures', () => {
  const pending = {
    source: 'douyin-hotspot',
    scrapedAt: '2026-06-22T05:27:20.180Z',
    items: [
      { id: 'done', url: 'https://example.com/done' },
      { id: 'retry', url: 'https://example.com/retry' },
      { id: 'give-up', url: 'https://example.com/give-up' },
      { id: 'later', url: 'https://example.com/later' },
    ],
    failures: {
      'give-up': { attempts: 1, lastError: 'old failure' },
    },
  };

  const result = updatePendingAfterFetch(pending, {
    completedIds: new Set(['done']),
    failedItems: new Map([
      ['retry', 'temporary timeout'],
      ['give-up', 'still invalid'],
    ]),
    processedIds: new Set(['done', 'retry', 'give-up']),
    maxAttempts: 2,
    now: '2026-06-23T10:00:00.000Z',
  });

  assert.deepEqual(result.terminalFailures.map(item => item.id), ['give-up']);
  assert.deepEqual(result.pending.items.map(item => item.id), ['retry', 'later']);
  assert.equal(result.pending.failures.retry.attempts, 1);
  assert.equal(result.pending.failures.retry.lastError, 'temporary timeout');
  assert.equal(result.pending.failures['give-up'], undefined);
  assert.equal(result.pending.failures.done, undefined);
});

test('buildFilteredMeta preserves source context while marking item filtered', () => {
  const meta = buildFilteredMeta({
    videoResult: {
      id: '123',
      platform: 'douyin',
      canonicalUrl: 'https://www.douyin.com/video/123',
      title: '图文内容',
      author: { name: '作者' },
      files: { videoPath: 'F:/tmp/123/video.mp4' },
    },
    pendingItem: {
      id: '123',
      url: 'https://www.douyin.com/video/123',
      billboards: [{ name: '视频总榜', rank: 1 }],
      context: { keyword: 'AI' },
    },
    source: 'douyin-hotspot',
    reason: '没有有效 video.mp4',
    now: '2026-06-23T10:00:00.000Z',
  });

  assert.equal(meta.status, 'filtered');
  assert.equal(meta.analysis.relevant, false);
  assert.equal(meta.scraped.keyword, 'AI');
  assert.equal(meta.analysis.filter_reason, '没有有效 video.mp4');
});
