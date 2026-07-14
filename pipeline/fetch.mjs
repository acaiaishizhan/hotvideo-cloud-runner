#!/usr/bin/env node
// ============================================================
//  视频下载（平台无关）：读取 pending.json，调用 video-infra 下载并生成 meta.json
//  用法: node fetch.mjs <sourceName>
//  如未传 sourceName，默认 douyin-hotspot
// ============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './json-file.mjs';
import { buildVideoInfraInvocation } from './video-infra-command.mjs';

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function runLimit() {
  const n = Number.parseInt(process.env.HOTVIDEO_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fetchMaxAttempts() {
  const n = Number.parseInt(process.env.HOTVIDEO_FETCH_MAX_ATTEMPTS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

async function loadSourceConfig(sourceName) {
  const configPath = path.resolve(import.meta.dirname, '..', 'sources', sourceName, 'config.mjs');
  if (!fs.existsSync(configPath)) {
    throw new Error(`source 配置不存在: ${configPath}`);
  }
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default;
}

function callVideoInfra(config, url, outputDir) {
  const invocation = buildVideoInfraInvocation(config, 'download', [url, '--output-dir', outputDir]);
  const raw = execFileSync(invocation.command, invocation.args, {
    encoding: 'utf-8',
    timeout: 120000,
    cwd: config.videoInfraCwd,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  return JSON.parse(raw);
}

const TERMINAL_FETCH_ERROR_PATTERNS = [
  'unable to extract render data',
  'unable to find video in feed',
  'video unavailable',
  'aweme not found',
  'item is not available',
  'private video',
  '视频不存在',
  '视频已删除',
  '视频不可用',
  '私密视频',
];

export function isTerminalFetchError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return TERMINAL_FETCH_ERROR_PATTERNS.some(pattern => message.includes(pattern.toLowerCase()));
}

export function shouldRetryExistingMeta(meta) {
  if (meta?.status !== 'filtered') return false;
  const reason = String(meta?.analysis?.filter_reason || '');
  return reason.includes('无法从分享页提取视频信息');
}

function buildMeta(videoResult, pendingItem, source) {
  return {
    id: videoResult.id || pendingItem.id,
    platform: videoResult.platform,
    source,
    url: videoResult.canonicalUrl || pendingItem.url,
    title: videoResult.title || '',
    description: videoResult.description || '',
    author: videoResult.author || {},
    durationSec: videoResult.durationSec,
    publishedAt: videoResult.publishedAt,
    thumbnailUrl: videoResult.thumbnailUrl || '',
    stats: videoResult.stats || {},
    files: videoResult.files || {},
    scraped: {
      billboards: pendingItem.billboards,
      ...pendingItem.context,
    },
    fetchedAt: new Date().toISOString(),
    status: 'new',
    analysis: null,
  };
}

export function isTerminalDownloadResult(videoResult) {
  const directUrl = String(videoResult?.media?.directUrl || '').toLowerCase();
  const formatUrls = Array.isArray(videoResult?.media?.formats)
    ? videoResult.media.formats.map(f => String(f?.url || '').toLowerCase())
    : [];
  const urls = [directUrl, ...formatUrls].filter(Boolean);
  if (urls.some(url => url.includes('.mp3') || url.includes('music'))) return true;

  const item = videoResult?.raw?.item;
  if (item?.aweme_type === 2 && Array.isArray(item.images) && item.images.length > 0) {
    return true;
  }

  return false;
}

export function buildFilteredMeta({ videoResult = {}, pendingItem, source, reason, now = new Date().toISOString() }) {
  return {
    id: videoResult.id || pendingItem.id,
    platform: videoResult.platform || (source.startsWith('douyin') ? 'douyin' : ''),
    source,
    url: videoResult.canonicalUrl || videoResult.sourceUrl || pendingItem.url,
    title: videoResult.title || pendingItem.title || '',
    description: videoResult.description || '',
    author: videoResult.author || {},
    durationSec: videoResult.durationSec,
    publishedAt: videoResult.publishedAt,
    thumbnailUrl: videoResult.thumbnailUrl || '',
    stats: videoResult.stats || {},
    files: videoResult.files || {},
    scraped: {
      billboards: pendingItem.billboards || [],
      ...(pendingItem.context || {}),
    },
    fetchedAt: now,
    filteredAt: now,
    status: 'filtered',
    analysis: {
      relevant: false,
      filter_reason: reason,
      summary: videoResult.title || pendingItem.title || '非视频内容，跳过 hotvideo 视频分析管线',
      content_type: '其他',
      topics: ['其他'],
      tags: ['下载失败'],
      hook: '',
      viral_reason: '',
      imitation_angle: '',
      read_evidence: '未读取视频：下载阶段没有产出有效 video.mp4。',
    },
  };
}

export function updatePendingAfterFetch(pending, {
  completedIds,
  failedItems,
  processedIds,
  maxAttempts,
  now = new Date().toISOString(),
}) {
  const failures = { ...(pending.failures || {}) };
  const remaining = [];
  const terminalFailures = [];

  for (const item of pending.items || []) {
    const id = item.id;

    if (completedIds.has(id)) {
      delete failures[id];
      continue;
    }

    if (failedItems.has(id)) {
      const previous = failures[id]?.attempts || 0;
      const attempts = previous + 1;
      const error = failedItems.get(id);
      if (attempts >= maxAttempts) {
        delete failures[id];
        terminalFailures.push({ ...item, error, attempts });
      } else {
        failures[id] = { attempts, lastError: error, lastFailedAt: now };
        remaining.push(item);
      }
      continue;
    }

    if (!processedIds.has(id)) {
      remaining.push(item);
    }
  }

  return {
    pending: {
      ...pending,
      items: remaining,
      failures,
      updatedAt: now,
    },
    terminalFailures,
  };
}

export async function runFetch(sourceName) {
  const config = await loadSourceConfig(sourceName);
  const pendingPath = path.join(config.videosDir, 'pending.json');

  log(`====== 视频下载开始 [${sourceName}] ======`);

  if (!fs.existsSync(pendingPath)) {
    log('没有待下载的视频（pending.json 不存在）');
    return { downloaded: 0, skipped: 0, failed: 0 };
  }

  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  const limit = runLimit();
  const items = limit ? pending.items.slice(0, limit) : pending.items;
  log(`来源: ${pending.source}，共 ${pending.items.length} 条${limit ? `，本次只处理 ${items.length} 条` : ''}`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let filtered = 0;
  const completedIds = new Set();
  const processedIds = new Set();
  const failedItems = new Map();
  const maxAttempts = fetchMaxAttempts();

  for (const item of items) {
    processedIds.add(item.id);
    const videoDir = path.join(config.videosDir, item.id);
    const metaPath = path.join(videoDir, 'meta.json');

    if (fs.existsSync(metaPath)) {
      const existing = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (shouldRetryExistingMeta(existing)) {
        log(`  重试历史下载误判: ${item.id}`);
      } else
      if (existing.status && existing.status !== 'new') {
        completedIds.add(item.id);
        skipped++;
        log(`  跳过已处理: ${item.id} (${existing.status})`);
        continue;
      }
      if (existing.files?.videoPath && fs.existsSync(existing.files.videoPath)) {
        completedIds.add(item.id);
        skipped++;
        log(`  跳过已下载: ${item.id}`);
        continue;
      }
    }

    log(`  下载: ${item.url}`);
    try {
      const result = callVideoInfra(config, item.url, videoDir);
      if (!result.ok) {
        throw new Error(result.error || 'video-infra 返回错误');
      }

      // video-infra 偶尔会 ok=true 但产出 0 字节文件（如抖音直链失效）
      // 提早在这里失败，避免把无效视频交给 analyze
      const videoPath = result.files?.videoPath;
      if (!videoPath || !fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1024) {
        if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (isTerminalDownloadResult(result)) {
          const reason = `非标准视频内容，video-infra 未产出有效 video.mp4: ${videoPath || '(无 path)'}`;
          const meta = buildFilteredMeta({ videoResult: result, pendingItem: item, source: pending.source, reason });
          fs.mkdirSync(videoDir, { recursive: true });
          writeJsonAtomic(metaPath, meta);
          completedIds.add(item.id);
          filtered++;
          log(`  过滤: ${reason}`);
          continue;
        }
        throw new Error(`下载文件无效（不存在或 < 1KB）: ${videoPath || '(无 path)'}`);
      }

      const meta = buildMeta(result, item, pending.source);
      fs.mkdirSync(videoDir, { recursive: true });
      writeJsonAtomic(metaPath, meta);
      completedIds.add(item.id);
      downloaded++;
      log(`  完成: ${(meta.title || '').substring(0, 40)}...`);
    } catch (err) {
      if (isTerminalFetchError(err)) {
        const reason = `下载阶段判定不可解析，跳过重试: ${err.message}`;
        const meta = buildFilteredMeta({ pendingItem: item, source: pending.source, reason });
        fs.mkdirSync(videoDir, { recursive: true });
        writeJsonAtomic(metaPath, meta);
        completedIds.add(item.id);
        filtered++;
        log(`  过滤: ${item.id} ${reason}`);
        continue;
      }
      failed++;
      failedItems.set(item.id, err.message);
      log(`  失败: ${err.message}`);
    }
  }

  const updated = updatePendingAfterFetch(pending, {
    completedIds,
    failedItems,
    processedIds,
    maxAttempts,
  });

  for (const item of updated.terminalFailures) {
    const videoDir = path.join(config.videosDir, item.id);
    const metaPath = path.join(videoDir, 'meta.json');
    const reason = `下载连续失败 ${item.attempts} 次，停止重试: ${item.error}`;
    const meta = buildFilteredMeta({ pendingItem: item, source: pending.source, reason });
    fs.mkdirSync(videoDir, { recursive: true });
    writeJsonAtomic(metaPath, meta);
    filtered++;
    log(`  过滤: ${item.id} ${reason}`);
  }

  if (updated.pending.items.length === 0) {
    fs.unlinkSync(pendingPath);
    log('pending.json 已清空');
  } else {
    writeJsonAtomic(pendingPath, updated.pending);
    log(`保留 pending.json: ${updated.pending.items.length} 条待重试/待处理`);
  }
  log(`====== 下载完成: ${downloaded} 成功, ${skipped} 跳过, ${filtered} 过滤, ${failed} 失败 ======`);

  return { downloaded, skipped, filtered, failed };
}

// 直接当脚本跑
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceName = process.argv[2] || 'douyin-hotspot';
  runFetch(sourceName).catch(err => {
    console.error('下载失败:', err);
    process.exit(1);
  });
}
