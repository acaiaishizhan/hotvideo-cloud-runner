#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_HOSTS = new Set(['douyin.com', 'www.douyin.com']);

export function validateManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('manifest 必须是 JSON 对象');
  if (value.source !== 'douyin-hotspot') throw new Error(`不支持的 source: ${value.source || '(空)'}`);
  if (!Array.isArray(value.items)) throw new Error('manifest.items 必须是数组');
  if (value.items.length > 1000) throw new Error('单批最多 1000 条');

  const ids = new Set();
  for (const [index, item] of value.items.entries()) {
    const id = String(item?.id || '');
    if (!/^\d{8,32}$/.test(id)) throw new Error(`items[${index}].id 非法`);
    if (ids.has(id)) throw new Error(`items[${index}].id 重复: ${id}`);
    ids.add(id);

    let url;
    try { url = new URL(String(item?.url || '')); } catch { throw new Error(`items[${index}].url 非法`); }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`items[${index}].url 只允许 https://www.douyin.com`);
    }
  }

  const repeatItems = value.repeatUpdates?.items;
  if (repeatItems !== undefined && !Array.isArray(repeatItems)) {
    throw new Error('manifest.repeatUpdates.items 必须是数组');
  }
  if ((repeatItems?.length || 0) > 5000) throw new Error('单批最多 5000 条重复更新');
  for (const [index, item] of (repeatItems || []).entries()) {
    const id = String(item?.id || '');
    if (!/^\d{8,32}$/.test(id)) throw new Error(`repeatUpdates.items[${index}].id 非法`);

    let url;
    try { url = new URL(String(item?.url || '')); } catch { throw new Error(`repeatUpdates.items[${index}].url 非法`); }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`repeatUpdates.items[${index}].url 只允许 https://www.douyin.com`);
    }
  }
  return value;
}

export function materializeManifest(manifest, videosDir) {
  fs.mkdirSync(videosDir, { recursive: true });
  const pending = {
    source: manifest.source,
    scrapedAt: manifest.scrapedAt,
    items: manifest.items,
  };
  fs.writeFileSync(path.join(videosDir, 'pending.json'), `${JSON.stringify(pending, null, 2)}\n`, 'utf-8');

  const repeatItems = manifest.repeatUpdates?.items || [];
  if (repeatItems.length > 0) {
    fs.writeFileSync(path.join(videosDir, 'repeat-updates.json'), `${JSON.stringify({
      source: manifest.source,
      scrapedAt: manifest.repeatUpdates?.scrapedAt || manifest.scrapedAt,
      items: repeatItems,
    }, null, 2)}\n`, 'utf-8');
  }
  return { newItems: manifest.items.length, repeatItems: repeatItems.length };
}

export function manifestScope(manifest) {
  const contexts = manifest.items.map(item => item?.context || {});
  const profiles = new Set(contexts.map(item => item.categoryProfile).filter(Boolean));
  const windows = new Set(contexts.map(item => String(item.dateWindow || '')).filter(Boolean));
  if (profiles.size > 1) throw new Error('同一 manifest 不能混用多个 categoryProfile');
  if (windows.size > 1) throw new Error('同一 manifest 不能混用多个 dateWindow');
  return {
    categoryProfile: profiles.values().next().value || '',
    dateWindow: windows.values().next().value || '',
  };
}

function assertSecrets(env = process.env) {
  const required = [
    'ARK_API_KEY',
    'HOTVIDEO_FEISHU_BASE_TOKEN',
    'HOTVIDEO_FEISHU_TABLE_ID',
  ];
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error(`缺少环境变量: ${missing.join(', ')}`);
}

function runPipeline(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', error => resolve({ code: 1, error }));
    child.on('exit', code => resolve({ code: code ?? 1 }));
  });
}

export function buildPipelineArgs(manifest, scope, { lane = 'fast' } = {}) {
  if (!['fast', 'slow'].includes(lane)) throw new Error(`不支持的分析车道: ${lane}`);
  const args = [
    'pipeline/orchestrator.mjs',
    '--source', manifest.source,
    '--skip-scrape',
    '--analyzer', 'doubao',
    '--analyze-lane', lane,
    '--analyze-concurrency', lane === 'slow'
      ? '1'
      : (process.env.HOTVIDEO_ANALYZE_CONCURRENCY || '5'),
  ];
  if (lane === 'slow') args.splice(4, 0, '--skip-fetch');
  if (scope.categoryProfile) args.push('--category-profile', scope.categoryProfile);
  if (scope.dateWindow) args.push('--date-window', scope.dateWindow);
  return args;
}

export async function runPipelinePhases(manifest, scope, run = runPipeline) {
  const fastArgs = buildPipelineArgs(manifest, scope, { lane: 'fast' });
  console.log(`云端 fast 管线 attempt 1/1`);
  const fast = await run(fastArgs);
  if (fast.code !== 0) return { phase: 'fast', result: fast };

  const slowArgs = buildPipelineArgs(manifest, scope, { lane: 'slow' });
  console.log(`云端 slow 管线 attempt 1/1`);
  const slow = await run(slowArgs);
  if (slow.code !== 0) return { phase: 'slow', result: slow };
  return { phase: 'complete', result: slow };
}

export async function main(argv = process.argv.slice(2)) {
  const queueArg = argv[0];
  if (!queueArg) throw new Error('用法: node scripts/run-queue.mjs queue/<run-id>.json');
  assertSecrets();

  const queuePath = path.resolve(ROOT, queueArg);
  const relative = path.relative(path.join(ROOT, 'queue'), queuePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('queue 文件必须位于 queue/ 下');

  const manifest = validateManifest(JSON.parse(fs.readFileSync(queuePath, 'utf-8')));
  const repeatCount = manifest.repeatUpdates?.items?.length || 0;
  if (manifest.items.length === 0 && repeatCount === 0) {
    console.log('manifest 没有待处理视频或重复更新，结束');
    return;
  }

  const scope = manifestScope(manifest);
  const videosDir = path.join(ROOT, 'videos', 'douyin-hotspot');
  const counts = materializeManifest(manifest, videosDir);
  console.log(`已装载队列: 新视频 ${counts.newItems} 条，重复更新 ${counts.repeatItems} 条`);

  process.env.HOTVIDEO_ANALYZER = 'doubao';
  process.env.HOTVIDEO_ANALYZE_LANE = 'fast';
  process.env.HOTVIDEO_ANALYZE_CONCURRENCY ||= '5';
  process.env.HOTVIDEO_FEISHU_IDENTITY = 'bot';
  if (scope.categoryProfile) process.env.HOTVIDEO_CATEGORY_PROFILE = scope.categoryProfile;
  if (scope.dateWindow) process.env.HOTVIDEO_DATE_WINDOW = scope.dateWindow;

  console.log(`云端队列: ${queueArg}`);
  const outcome = await runPipelinePhases(manifest, scope);
  if (outcome.result.code !== 0) {
    throw outcome.result.error || new Error(`${outcome.phase} 管线失败，exitCode=${outcome.result.code}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
