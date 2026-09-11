import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, buildRepeatUpdateRecord } from './publish.mjs';
test('replayed old statistics cannot overwrite a newer refresh', () => {
  const meta = { source:'douyin-hotspot',title:'title',scraped:{hotspotDetail:{likeCount:10,capturedAt:'2026-09-11T00:00:00Z'}} };
  const record = buildRecord(meta,{existingRefreshedAt:'2026-09-11T08:00:00Z'});
  assert.equal(record['点赞数'],undefined);
  assert.equal(record['数据刷新时间'],undefined);
  assert.equal(record['标题'],'title');
  delete meta.scraped.hotspotDetail.capturedAt;
  assert.equal(buildRepeatUpdateRecord(meta,{existingRefreshedAt:'2026-09-11T08:00:00Z'})['点赞数'],undefined);
});
test('new statistics carry their real collection time', () => {
  const meta = { source:'douyin-hotspot',scraped:{hotspotDetail:{likeCount:10,capturedAt:'2026-09-11T08:00:00Z'}} };
  const record = buildRecord(meta,{existingRefreshedAt:'2026-09-11T00:00:00Z'});
  assert.equal(record['点赞数'],10);
  assert.equal(record['数据刷新时间'],'2026-09-11 16:00:00');
});
