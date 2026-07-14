import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestScope, validateManifest } from '../scripts/run-queue.mjs';

const item = {
  id: '7662251858534157620',
  url: 'https://www.douyin.com/video/7662251858534157620',
  billboards: [{ name: '视频总榜', rank: 1 }],
  context: { categoryProfile: 'tech-kepu', dateWindow: 1 },
};

test('接受合法的抖音热点 manifest', () => {
  const manifest = { source: 'douyin-hotspot', scrapedAt: new Date().toISOString(), items: [item] };
  assert.equal(validateManifest(manifest), manifest);
  assert.deepEqual(manifestScope(manifest), { categoryProfile: 'tech-kepu', dateWindow: '1' });
});

test('拒绝非抖音 URL', () => {
  assert.throws(() => validateManifest({
    source: 'douyin-hotspot',
    items: [{ ...item, url: 'https://example.com/video/1' }],
  }), /只允许/);
});

test('拒绝混合类目，避免飞书发布范围串批', () => {
  assert.throws(() => manifestScope({ items: [
    item,
    { ...item, id: '7662251858534157621', context: { categoryProfile: 'renwen-guoxue', dateWindow: 1 } },
  ] }), /多个 categoryProfile/);
});
