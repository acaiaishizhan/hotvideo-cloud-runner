import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInteractionUpdateRecord,
  buildRecord,
  buildRepeatUpdateRecord,
  hasAttachmentFiles,
  isAttachmentUploadAccepted,
  isLarkRateLimitError,
  larkExecArgs,
  larkRateLimitRetryDelayMs,
  recordFieldIndex,
  resolvePublishedRecordRepair,
  runWithLarkRateLimitRetry,
  shouldUploadAttachment,
  shouldPublishMetaInScope,
} from './publish.mjs';

test('runWithLarkRateLimitRetry honors Retry-After and succeeds on the next attempt', () => {
  let attempts = 0;
  const sleeps = [];
  const result = runWithLarkRateLimitRetry(() => {
    attempts++;
    if (attempts === 1) {
      const error = new Error('HTTP 429 Too Many Requests');
      error.stderr = 'Retry-After: 2';
      throw error;
    }
    return { ok: true };
  }, {
    sleep: ms => sleeps.push(ms),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('runWithLarkRateLimitRetry uses bounded fallback delays and then fails', () => {
  let attempts = 0;
  const sleeps = [];
  assert.throws(() => runWithLarkRateLimitRetry(() => {
    attempts++;
    throw new Error('SDK invalid response (HTTP 429)');
  }, {
    maxAttempts: 3,
    fallbackMs: 1500,
    sleep: ms => sleeps.push(ms),
  }), /HTTP 429/);

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1500, 1500]);
});

test('runWithLarkRateLimitRetry does not retry non-429 errors', () => {
  let attempts = 0;
  const sleeps = [];
  assert.throws(() => runWithLarkRateLimitRetry(() => {
    attempts++;
    throw new Error('HTTP 400 参数不合法');
  }, {
    sleep: ms => sleeps.push(ms),
  }), /HTTP 400/);

  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(isLarkRateLimitError({ ok: false, error: { message: 'HTTP 429' } }), true);
  assert.equal(larkRateLimitRetryDelayMs('HTTP 429 retry after 0.5'), 500);
});

test('larkExecArgs retries a non-JSON HTTP 429 body and then parses success', () => {
  let attempts = 0;
  const sleeps = [];
  const result = larkExecArgs(['base', '+record-list'], 30000, {
    execute: () => {
      attempts++;
      return attempts === 1
        ? '<html>HTTP 429 Too Many Requests</html>'
        : JSON.stringify({ ok: true, data: { rows: 1 } });
    },
    sleep: ms => sleeps.push(ms),
    onRetry: () => {},
  });

  assert.deepEqual(result, { ok: true, data: { rows: 1 } });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [3000]);
});

test('larkExecArgs does not retry an unrelated non-JSON response', () => {
  let attempts = 0;
  assert.throws(() => larkExecArgs(['base', '+record-list'], 30000, {
    execute: () => {
      attempts++;
      return '<html>gateway broke</html>';
    },
    sleep: () => {},
    onRetry: () => {},
  }), /返回非 JSON/);
  assert.equal(attempts, 1);
});

test('resolveRecordTitle 用分析摘要兜底占位符标题，正常标题原样保留', () => {
  assert.equal(
    buildRecord({ title: '抖音视频_7661961288540622099', analysis: { summary: '讲解易经与现代生活的关系' } })['标题'],
    '讲解易经与现代生活的关系（无原标题）',
  );
  assert.equal(
    buildRecord({ title: '', analysis: { summary: 'x'.repeat(60) } })['标题'],
    `${'x'.repeat(50)}…（无原标题）`,
  );
  assert.equal(buildRecord({ title: '正常标题', analysis: { summary: '摘要' } })['标题'], '正常标题');
  assert.equal(buildRecord({ title: '抖音视频_123', analysis: {} })['标题'], '抖音视频_123');
});

test('buildRecord writes source type, billboard names, and date window fields', () => {
  const record = buildRecord({
    id: '7650122231460220160',
    platform: 'douyin',
    source: 'douyin-hotspot',
    url: 'https://www.douyin.com/video/7650122231460220160',
    title: '测试视频',
    author: { name: '作者' },
    durationSec: 12,
    stats: { viewCount: 100, likeCount: 10, commentCount: 2, shareCount: 3, favoriteCount: 4 },
    scraped: {
      sourceType: '科技/科技科普',
      likeRate: 0.1,
      hotspotDetail: { likeCount: 10, commentCount: 2, shareCount: 3, newFansCount: 755 },
      billboards: [
        { name: '视频总榜', rank: 1 },
        { name: '高完播率', rank: 2 },
      ],
      dateWindow: 1,
    },
    analysis: {
      summary: '摘要',
      content_type: '工具教程',
      topics: ['AI编程'],
      tags: ['测试'],
      hook: '开头',
      viral_reason: '原因',
      imitation_angle: '角度',
      full_video_copy: '完整口播字幕',
    },
  });

  assert.equal(record['类型'], '科技/科技科普');
  assert.deepEqual(record['榜单'], ['视频总榜', '高完播率']);
  assert.equal(record['时间段'], '近1小时');
  assert.equal(record['点赞率'], 0.1);
  assert.equal(record['点赞数'], 10);
  assert.equal(record['评论数'], 2);
  assert.equal(record['收藏数'], undefined);
  assert.equal(record['分享数'], 3);
  assert.equal(record['涨粉数'], 755);
  assert.equal(record['播放量'], undefined);
  assert.equal(record['完整视频文案'], '完整口播字幕');
});

test('buildRecord fills douyin-hotspot source type and like rate for legacy meta', () => {
  const record = buildRecord({
    id: '7650122231460220160',
    platform: 'douyin',
    source: 'douyin-hotspot',
    url: 'https://www.douyin.com/video/7650122231460220160',
    title: '旧数据',
    scraped: {
      billboards: [{ name: '视频总榜', rank: 1 }],
      dateWindow: 24,
    },
    metrics: {
      like_rate: 0.23,
    },
    analysis: {},
  });

  assert.equal(record['类型'], '科技/科技科普');
  assert.equal(record['时间段'], '近1天');
  assert.equal(record['点赞率'], 0.23);
});

test('buildRecord ignores hotspot ranking play and like counts and keeps formula field read-only', () => {
  const record = buildRecord({
    id: '7456283418616237322',
    platform: 'douyin',
    source: 'douyin-hotspot',
    url: 'https://www.douyin.com/video/7456283418616237322',
    title: '热点页有播放量',
    stats: { viewCount: 0, likeCount: 0 },
    scraped: {
      playCount: 75028,
      likeCount: 3000,
    },
    analysis: {},
  });

  assert.equal(record['播放量'], undefined);
  assert.equal(record['点赞数'], undefined);
});

test('buildInteractionUpdateRecord maps direct Douyin interaction stats without favorite', () => {
  const record = buildInteractionUpdateRecord({
    stats: {
      viewCount: 0,
      likeCount: 11812,
      commentCount: 215,
      favoriteCount: 5273,
      shareCount: 2875,
    },
  });

  assert.deepEqual(record, {
    '点赞数': 11812,
    '评论数': 215,
    '分享数': 2875,
  });
});

test('buildInteractionUpdateRecord uses hotspot detail totals only and omits missing detail fields', () => {
  const record = buildInteractionUpdateRecord({
    source: 'douyin-hotspot',
    stats: {
      likeCount: 100,
      commentCount: 10,
      shareCount: 5,
      favoriteCount: 999,
    },
    scraped: {
      likeCount: 3,
      likeRate: 0.02,
      hotspotDetail: {
        likeCount: 180,
        commentCount: 0,
        shareCount: 9,
      },
    },
  });

  assert.deepEqual(record, {
    '点赞数': 180,
    '分享数': 9,
    '点赞率': 0.02,
  });
});

test('buildInteractionUpdateRecord does not mix Douyin stats into a hotspot row when detail is absent', () => {
  assert.deepEqual(buildInteractionUpdateRecord({
    source: 'douyin-hotspot',
    stats: { likeCount: 100, commentCount: 10, shareCount: 5 },
    metrics: { like_count: 90, comment_count: 9, share_count: 4 },
    scraped: { likeRate: 0.02 },
  }), {
    '点赞率': 0.02,
  });
});

test('buildInteractionUpdateRecord omits a zero like rate instead of breaking the play formula', () => {
  assert.deepEqual(buildInteractionUpdateRecord({
    source: 'douyin-hotspot',
    scraped: { likeRate: 0, hotspotDetail: { likeCount: 180 } },
  }), {
    '点赞数': 180,
  });
});

test('buildRepeatUpdateRecord only contains fields safe to refresh for an existing Feishu row', () => {
  const record = buildRepeatUpdateRecord({
    id: '7650122231460220160',
    platform: 'douyin',
    source: 'douyin-hotspot',
    url: 'https://www.douyin.com/video/7650122231460220160',
    title: '重复视频',
    scraped: {
      sourceType: '科技/科技科普',
      billboards: [
        { name: '视频总榜', rank: 1 },
        { name: '高点赞率', rank: 2 },
      ],
      dateWindow: 1,
      likeCount: 120,
      likeRate: 0.12,
      hotspotDetail: {
        likeCount: 11812,
        commentCount: 215,
        shareCount: 2875,
        newFansCount: 755,
      },
    },
    analysis: {
      summary: '旧分析不要覆盖',
      full_video_copy: '旧文案不要覆盖',
    },
  });

  assert.deepEqual(record, {
    '标题': '重复视频',
    '视频链接': 'https://www.douyin.com/video/7650122231460220160',
    '平台': '抖音',
    '类型': '科技/科技科普',
    '榜单': ['视频总榜', '高点赞率'],
    '时间段': '近1小时',
    '点赞数': 11812,
    '点赞率': 0.12,
    '评论数': 215,
    '分享数': 2875,
    '涨粉数': 755,
  });
});

test('isAttachmentUploadAccepted rejects ignored attachment fields even when CLI returns ok', () => {
  assert.equal(isAttachmentUploadAccepted({
    ok: true,
    data: {
      attachments: {},
      ignored_fields: [
        {
          id: 'fldgReMdHu',
          name: '视频文件',
          reason: 'MOBILE_ONLY: attachment field input is limited to mobile upload.',
        },
      ],
    },
  }), false);
});

test('isAttachmentUploadAccepted accepts uploads with returned attachment data', () => {
  assert.equal(isAttachmentUploadAccepted({
    ok: true,
    data: {
      attachments: {
        fldgReMdHu: [{ file_token: 'boxcnxxx', name: 'video.mp4' }],
      },
    },
  }), true);
});

test('isAttachmentUploadAccepted accepts nested record and field attachment data', () => {
  assert.equal(isAttachmentUploadAccepted({
    ok: true,
    data: {
      attachments: {
        recvnmDN7e54aF: {
          fldgReMdHu: [{ file_token: 'FeIPbdLrAoq4JOxzmv1cg3nInAP', name: 'video.mp4' }],
        },
      },
    },
  }), true);
});

test('hasAttachmentFiles recognizes remote attachment cells and empty values', () => {
  assert.equal(hasAttachmentFiles([{ file_token: 'boxcnxxx', name: 'video.mp4' }]), true);
  assert.equal(hasAttachmentFiles('[video.mp4](https://example.invalid/file)'), true);
  assert.equal(hasAttachmentFiles([]), false);
  assert.equal(hasAttachmentFiles('[]'), false);
  assert.equal(hasAttachmentFiles(null), false);
});

test('shouldUploadAttachment only allows a confirmed empty remote cell', () => {
  assert.equal(shouldUploadAttachment({ attachmentKnown: true, hasAttachment: false }), true);
  assert.equal(shouldUploadAttachment({ attachmentKnown: true, hasAttachment: true }), false);
  assert.throws(
    () => shouldUploadAttachment({ attachmentKnown: false, hasAttachment: false }),
    /状态不明确/,
  );
});

test('recordFieldIndex accepts field names and field IDs from Lark JSON responses', () => {
  const fields = ['视频链接', '视频文件'];
  const fieldIds = ['fldgK0lbvI', 'fldgReMdHu'];
  assert.equal(recordFieldIndex(fields, fieldIds, '视频链接'), 0);
  assert.equal(recordFieldIndex(fields, fieldIds, 'fldgReMdHu'), 1);
  assert.equal(recordFieldIndex(fields, fieldIds, 'missing'), -1);
});

test('shouldPublishMetaInScope filters stale analyzed records outside the active category profile', () => {
  const scope = { sourceType: '人文社科/社科', dateWindow: 24 };

  assert.equal(shouldPublishMetaInScope({
    status: 'analyzed',
    scraped: { sourceType: '科技/科技科普', dateWindow: 1 },
  }, scope), false);

  assert.equal(shouldPublishMetaInScope({
    status: 'analyzed',
    scraped: { sourceType: '人文社科/社科', dateWindow: 24 },
  }, scope), true);
});

test('resolvePublishedRecordRepair rebuilds a published row missing from URL lookup', () => {
  assert.deepEqual(resolvePublishedRecordRepair({
    status: 'published',
    feishu_record_id: 'rec_blank',
  }, ''), {
    recordId: 'rec_blank',
    shouldRepair: true,
    createNew: true,
  });

  assert.deepEqual(resolvePublishedRecordRepair({
    status: 'published',
    feishu_record_id: 'rec_saved',
  }, 'rec_saved'), {
    recordId: 'rec_saved',
    shouldRepair: false,
    createNew: false,
  });
});
