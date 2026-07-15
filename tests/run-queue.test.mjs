import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  manifestScope,
  materializeManifest,
  runFetchUntilSettled,
  validateManifest,
} from '../scripts/run-queue.mjs';

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

test('把新视频和重复榜单更新分别落给管线', t => {
  const videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-queue-'));
  t.after(() => fs.rmSync(videosDir, { recursive: true, force: true }));
  const repeatItem = {
    ...item,
    status: 'repeat',
    scraped: { categoryProfile: 'tech-kepu', dateWindow: 1 },
  };
  const manifest = validateManifest({
    source: 'douyin-hotspot',
    scrapedAt: new Date().toISOString(),
    items: [item],
    repeatUpdates: { items: [repeatItem] },
  });

  assert.deepEqual(materializeManifest(manifest, videosDir), { newItems: 1, repeatItems: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(videosDir, 'pending.json'))).items.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(videosDir, 'repeat-updates.json'))).items.length, 1);
});

test('下载失败在下载阶段内收敛，不重跑分析和发布', async () => {
  let calls = 0;
  await runFetchUntilSettled('douyin-hotspot', '/tmp/videos', {
    attempts: 3,
    delayMs: 0,
    runFetchImpl: async () => { calls++; },
    hasPendingItemsImpl: () => calls < 3,
  });
  assert.equal(calls, 3);
});

test('下载重试耗尽后明确失败', async () => {
  await assert.rejects(() => runFetchUntilSettled('douyin-hotspot', '/tmp/videos', {
    attempts: 2,
    delayMs: 0,
    runFetchImpl: async () => {},
    hasPendingItemsImpl: () => true,
  }), /仍有 pending\.json/);
});
