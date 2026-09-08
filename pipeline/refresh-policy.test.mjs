import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRefreshPage, parseFeishuDate } from './refresh-policy.mjs';
import { buildStatisticsRefreshRecord, buildRecord } from './publish.mjs';
const now = new Date('2026-09-08T08:00:00+08:00');
function page(rows) {
  return { ok: true, data: { fields: ['标题', '视频链接', '发布时间', '平台', '创建时间', '最近上榜时间'], data: rows, record_id_list: rows.map((_, i) => 'rec' + i), has_more: false } };
}
test('recent ingestion and reappearance qualify even if publication is missing or old', () => {
  const p = page([
    ['A','https://www.douyin.com/video/7650122231460220160',null,'抖音','2026-09-07 08:00:00',null],
    ['B','https://www.douyin.com/video/7649026123325672714','2026-07-01 08:00:00','抖音','2026-07-01 08:00:00','2026-09-07 08:00:00'],
    ['C','https://www.douyin.com/video/7631602331755619187','2026-09-07 08:00:00','抖音','2026-07-01 08:00:00',null],
  ]);
  const result = parseRefreshPage(p, { platform: '抖音', now });
  assert.deepEqual(result.items.map(x => x.title), ['A', 'B']);
  assert.equal(result.stats.outsideWindow, 1);
});
test('source dates are timezone-safe and valid zero is not confused with absence', () => {
  assert.equal(parseFeishuDate(0), null);
  assert.equal(parseFeishuDate('2026-09-08').toISOString(), '2026-09-07T16:00:00.000Z');
  assert.equal(parseFeishuDate('2026-09-08 08:00:00').toISOString(), '2026-09-08T00:00:00.000Z');
  const record = buildStatisticsRefreshRecord({ platform: 'youtube', metrics: { viewCount: 0, likeCount: null, commentCount: '' }, refreshedAt: now, publishedAt: '2026-07-07T00:00:00Z' });
  assert.equal(record['播放量（真实）'], 0);
  assert.equal(record['数据刷新时间'], '2026-09-08 08:00:00');
  assert.equal(record['发布时间'], '2026-07-07 08:00:00');
  assert.ok(!('点赞数' in record));
  assert.deepEqual(buildStatisticsRefreshRecord({ platform: 'youtube', metrics: {}, refreshedAt: now }), {});
});
test('publishing missing dates cannot erase an existing remote date', () => {
  assert.ok(!('发布时间' in buildRecord({ title: 'test', analysis: {} })));
  assert.equal(buildRecord({ title: 'test', scraped: { hotspotDetail: { publishedAt: 1783376700 } } })['发布时间'], '2026-07-07 06:25:00');
});
