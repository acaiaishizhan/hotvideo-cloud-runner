import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPipelineArgs,
  manifestScope,
  materializeManifest,
  runPipelinePhases,
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

test('云端 fast 阶段只跳过抓榜并机械复用本机 fast 管线', () => {
  const args = buildPipelineArgs(
    { source: 'douyin-hotspot' },
    { categoryProfile: 'tech-kepu', dateWindow: '1' },
  );
  assert.deepEqual(args, [
    'pipeline/orchestrator.mjs',
    '--source', 'douyin-hotspot',
    '--skip-scrape',
    '--analyzer', 'doubao',
    '--analyze-lane', 'fast',
    '--analyze-concurrency', '5',
    '--category-profile', 'tech-kepu',
    '--date-window', '1',
  ]);
  assert.equal(args.includes('--skip-fetch'), false);
  assert.equal(args.includes('all'), false);
});

test('云端 slow 阶段复用已下载视频并锁定单并发', () => {
  const args = buildPipelineArgs(
    { source: 'douyin-hotspot' },
    { categoryProfile: 'tech-kepu', dateWindow: '1' },
    { lane: 'slow' },
  );
  assert.deepEqual(args, [
    'pipeline/orchestrator.mjs',
    '--source', 'douyin-hotspot',
    '--skip-scrape',
    '--skip-fetch',
    '--analyzer', 'doubao',
    '--analyze-lane', 'slow',
    '--analyze-concurrency', '1',
    '--category-profile', 'tech-kepu',
    '--date-window', '1',
  ]);
  assert.equal(args.includes('all'), false);
});

test('fast 成功后按顺序进入 slow 阶段', async () => {
  const calls = [];
  const outcome = await runPipelinePhases(
    { source: 'douyin-hotspot' },
    { categoryProfile: 'tech-kepu', dateWindow: '1' },
    async args => {
      calls.push(args);
      return { code: 0 };
    },
  );

  assert.equal(outcome.phase, 'complete');
  assert.deepEqual(calls.map(args => args[args.indexOf('--analyze-lane') + 1]), ['fast', 'slow']);
});

test('fast 失败时不进入 slow 阶段', async () => {
  const calls = [];
  const outcome = await runPipelinePhases(
    { source: 'douyin-hotspot' },
    {},
    async args => {
      calls.push(args);
      return { code: 1 };
    },
  );

  assert.equal(outcome.phase, 'fast');
  assert.equal(calls.length, 1);
});

test('slow 失败时返回 slow 阶段失败', async () => {
  let call = 0;
  const outcome = await runPipelinePhases(
    { source: 'douyin-hotspot' },
    {},
    async () => ({ code: ++call === 1 ? 0 : 1 }),
  );

  assert.equal(outcome.phase, 'slow');
  assert.equal(outcome.result.code, 1);
  assert.equal(call, 2);
});
