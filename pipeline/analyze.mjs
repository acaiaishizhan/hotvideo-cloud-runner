#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  prepareAnalysisVideoChunks,
  prepareAnalysisVideoProxy,
} from './analysis-video-proxy.mjs';
import {
  analyzeVideoWithDoubao,
  shouldFallbackToFileId,
} from './doubao-analyzer.mjs';
import { writeJsonAtomic } from './json-file.mjs';
import { CONTENT_TYPES, TOPICS } from './prompt.mjs';
import { isValidVideoFile, resolveVideoPath } from './video-file.mjs';

const DEFAULT_SLOW_VIDEO_DURATION_SEC = 600;
const DEFAULT_SLOW_VIDEO_BYTES = 32 * 1024 * 1024;

function log(message) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${message}`);
}

function analyzeLimit() {
  const raw = process.env.HOTVIDEO_ANALYZE_LIMIT || process.env.HOTVIDEO_LIMIT || '';
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function resolveAnalyzeConcurrency(env = process.env) {
  const value = Number.parseInt(env.HOTVIDEO_ANALYZE_CONCURRENCY || '', 10);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

export function resolveAnalyzeLane(env = process.env) {
  const lane = (env.HOTVIDEO_ANALYZE_LANE || 'all').trim().toLowerCase();
  if (['fast', 'slow', 'all'].includes(lane)) return lane;
  throw new Error(`不支持的 HOTVIDEO_ANALYZE_LANE: ${lane}`);
}

export function resolveAnalyzeLaneThresholds(env = process.env) {
  const durationSec = Number.parseInt(env.HOTVIDEO_SLOW_VIDEO_DURATION_SEC || '', 10);
  const videoBytes = Number.parseInt(env.HOTVIDEO_SLOW_VIDEO_BYTES || '', 10);
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : DEFAULT_SLOW_VIDEO_DURATION_SEC,
    videoBytes: Number.isFinite(videoBytes) && videoBytes > 0
      ? videoBytes
      : DEFAULT_SLOW_VIDEO_BYTES,
  };
}

export function classifyAnalyzeLane(meta = {}, videoBytes = 0, thresholds = resolveAnalyzeLaneThresholds()) {
  const durationSec = meta.durationSec
    ?? (typeof meta.duration === 'number' ? Math.round(meta.duration / 1000) : 0);
  return durationSec > thresholds.durationSec || videoBytes > thresholds.videoBytes ? 'slow' : 'fast';
}

function formatDuration(seconds) {
  const total = Math.round(seconds || 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function loadSourceConfig(sourceName) {
  const configPath = path.resolve(import.meta.dirname, '..', 'sources', sourceName, 'config.mjs');
  if (!fs.existsSync(configPath)) throw new Error(`source 配置不存在: ${configPath}`);
  return (await import(pathToFileURL(configPath).href)).default;
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function normalizeDoubaoAnalysis(result) {
  if (typeof result?.relevant !== 'boolean') throw new Error('分析结果 relevant 必须是 boolean');
  if (typeof result?.has_spoken_audio !== 'boolean') {
    throw new Error('分析结果 has_spoken_audio 必须是 boolean');
  }

  const analysis = {
    relevant: result.relevant,
    has_spoken_audio: result.has_spoken_audio,
    filter_reason: stringValue(result.filter_reason),
    summary: stringValue(result.summary),
    content_type: stringValue(result.content_type),
    topics: stringArray(result.topics),
    tags: stringArray(result.tags),
    hook: stringValue(result.hook),
    viral_reason: stringValue(result.viral_reason),
    imitation_angle: stringValue(result.imitation_angle),
    read_evidence: stringValue(result.read_evidence),
    full_video_copy: stringValue(result.full_video_copy),
  };

  if (!CONTENT_TYPES.includes(analysis.content_type)) analysis.content_type = '其他';
  analysis.topics = analysis.topics.filter(topic => TOPICS.includes(topic));
  if (analysis.topics.length === 0) analysis.topics = ['其他'];

  if (!analysis.has_spoken_audio) {
    analysis.relevant = false;
    analysis.filter_reason = '无有效口播';
    analysis.full_video_copy = '';
  } else if (!analysis.full_video_copy.trim()) {
    throw new Error('豆包标记存在口播，但 full_video_copy 为空');
  }

  if (analysis.relevant) analysis.filter_reason = '';
  return analysis;
}

export function buildInvalidVideoMeta(meta, videoPath, now = new Date().toISOString()) {
  return {
    ...meta,
    has_video: false,
    status: 'filtered',
    filteredAt: now,
    analysis: {
      relevant: false,
      has_spoken_audio: false,
      filter_reason: `video.mp4 缺失或小于 1KB: ${path.basename(videoPath)}`,
      summary: meta.title || '无效视频记录',
      content_type: '其他',
      topics: ['其他'],
      tags: ['缺失视频'],
      hook: '',
      viral_reason: '',
      imitation_angle: '',
      read_evidence: '未读取视频：下载阶段没有产出有效视频文件。',
      full_video_copy: '',
    },
  };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number.parseInt(String(concurrency || 1), 10) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

export function mergeChunkDoubaoOutputs(outputs) {
  const results = outputs.map(output => output.result);
  const spoken = results.filter(result => result?.has_spoken_audio === true);
  const relevant = results.filter(result => result?.relevant === true);
  const primary = relevant[0] || spoken[0] || results[0] || {};
  const unique = values => [...new Set(values.flat().filter(Boolean))];
  return {
    result: {
      has_spoken_audio: spoken.length > 0,
      relevant: relevant.length > 0,
      filter_reason: relevant.length > 0
        ? ''
        : unique(results.map(result => result?.filter_reason || '')).join('；') || '分段均不符合收录标准',
      summary: primary.summary || '',
      content_type: primary.content_type || '其他',
      topics: unique(results.map(result => result?.topics || [])).slice(0, 3),
      tags: unique(results.map(result => result?.tags || [])).slice(0, 5),
      hook: primary.hook || '',
      viral_reason: primary.viral_reason || '',
      imitation_angle: primary.imitation_angle || '',
      read_evidence: results.map(result => result?.read_evidence || '').filter(Boolean).join('；'),
      full_video_copy: spoken.map(result => result.full_video_copy || '').filter(Boolean).join('\n'),
    },
    runtime: {
      provider: 'doubao',
      model: outputs[0]?.runtime?.model || '',
      baseUrl: outputs[0]?.runtime?.baseUrl || '',
      videoInput: 'chunked_data_url',
      chunkCount: outputs.length,
    },
  };
}

async function analyzeWithChunkFallback(videoDir, analysisMeta, error) {
  if (process.env.HOTVIDEO_DOUBAO_CHUNK_FALLBACK_ENABLED !== '1'
    || !shouldFallbackToFileId(error, 'data_url')) throw error;
  const videoPath = resolveVideoPath(videoDir, analysisMeta);
  const chunks = prepareAnalysisVideoChunks(videoPath);
  const concurrency = Number.parseInt(process.env.HOTVIDEO_ANALYZE_CHUNK_CONCURRENCY || '2', 10);
  log(`  整段解析失败，切为 ${chunks.length} 个视频分段，concurrency=${concurrency}`);
  const outputs = await mapWithConcurrency(chunks, concurrency, (chunkPath, index) => (
    analyzeVideoWithDoubao(videoDir, {
      ...analysisMeta,
      title: `${analysisMeta.title || ''} [分段 ${index + 1}/${chunks.length}]`,
      files: { ...(analysisMeta.files || {}), videoPath: chunkPath },
    })
  ));
  return mergeChunkDoubaoOutputs(outputs);
}

export async function runAnalyze(sourceName) {
  const config = await loadSourceConfig(sourceName);
  const lane = resolveAnalyzeLane();
  const concurrency = resolveAnalyzeConcurrency();
  const thresholds = resolveAnalyzeLaneThresholds();
  const limit = analyzeLimit();

  log(`====== 视频分析开始 [${sourceName}] analyzer=doubao concurrency=${concurrency} lane=${lane} ======`);
  if (!fs.existsSync(config.videosDir)) return { analyzed: 0, filtered: 0, skipped: 0, failed: 0 };

  const targets = [];
  let skipped = 0;
  let deferredSlow = 0;
  let laneSkipped = 0;

  for (const dir of fs.readdirSync(config.videosDir)) {
    const metaPath = path.join(config.videosDir, dir, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (meta.status !== 'new' || (limit && targets.length >= limit)) {
      skipped++;
      continue;
    }

    const videoDir = path.join(config.videosDir, dir);
    const videoPath = resolveVideoPath(videoDir, meta);
    let videoBytes = 0;
    try { videoBytes = fs.statSync(videoPath).size; } catch {}
    const itemLane = classifyAnalyzeLane(meta, videoBytes, thresholds);
    if (lane !== 'all' && itemLane !== lane) {
      if (lane === 'fast' && itemLane === 'slow') deferredSlow++;
      else laneSkipped++;
      continue;
    }
    targets.push({ metaPath, meta, videoDir, videoPath, videoBytes, itemLane });
  }

  log(`分析候选: ${targets.length} 条，慢车道延后 ${deferredSlow} 条，其他车道跳过 ${laneSkipped} 条`);

  const results = await mapWithConcurrency(targets, concurrency, async target => {
    const { metaPath, meta, videoDir, videoPath, videoBytes, itemLane } = target;
    const startedAt = Date.now();
    const durationSec = meta.durationSec
      ?? (typeof meta.duration === 'number' ? Math.round(meta.duration / 1000) : 0);
    const profile = `lane=${itemLane} duration=${formatDuration(durationSec)} size=${(videoBytes / 1024 / 1024).toFixed(1)}MB`;
    log(`分析: ${(meta.title || '').substring(0, 50)}... (${profile})`);

    try {
      if (!isValidVideoFile(videoPath)) {
        const next = buildInvalidVideoMeta(meta, videoPath);
        writeJsonAtomic(metaPath, next);
        return { status: 'filtered' };
      }

      let analysisMeta = meta;
      let proxyRuntime = null;
      const proxyAllVideos = process.env.HOTVIDEO_ANALYZE_PROXY_ALL === '1';
      if ((proxyAllVideos || itemLane === 'slow') && process.env.HOTVIDEO_ANALYZE_PROXY_ENABLED !== '0') {
        proxyRuntime = prepareAnalysisVideoProxy(videoPath, durationSec);
        log(`  标准分析副本${proxyRuntime.cached ? '命中缓存' : '生成完成'}: ${(proxyRuntime.proxyBytes / 1024 / 1024).toFixed(1)}MB`);
        analysisMeta = {
          ...meta,
          files: { ...(meta.files || {}), videoPath: proxyRuntime.path },
        };
      }

      let output;
      try {
        output = await analyzeVideoWithDoubao(videoDir, analysisMeta);
      } catch (error) {
        output = await analyzeWithChunkFallback(videoDir, analysisMeta, error);
      }
      const analysis = normalizeDoubaoAnalysis(output.result);
      const elapsedMs = Date.now() - startedAt;
      const next = {
        ...meta,
        analysis,
        status: analysis.relevant ? 'analyzed' : 'filtered',
        analyzed_at: new Date().toISOString(),
        analyzer: 'doubao',
        transcript: {
          ...(meta.transcript || {}),
          status: 'done',
          transcribedAt: new Date().toISOString(),
          provider: output.runtime?.provider,
          model: output.runtime?.model,
          audioAccess: analysis.has_spoken_audio,
        },
        analysisRuntime: {
          ...(output.runtime || {}),
          lane: itemLane,
          durationSec,
          videoBytes,
          elapsedMs,
          ...(proxyRuntime ? { proxy: {
            cached: proxyRuntime.cached,
            sourceBytes: proxyRuntime.sourceBytes,
            proxyBytes: proxyRuntime.proxyBytes,
          } } : {}),
        },
      };
      writeJsonAtomic(metaPath, next);
      log(`  ${analysis.relevant ? '完成' : '过滤'} [${(elapsedMs / 1000).toFixed(1)}s]: ${analysis.summary || analysis.filter_reason}`);
      return { status: next.status };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      log(`  失败 [${(elapsedMs / 1000).toFixed(1)}s] (${profile}): ${error.message}`);
      return { status: 'failed', reason: String(error?.message || error) };
    }
  });

  let analyzed = 0;
  let filtered = 0;
  let failed = 0;
  const failureReasons = [];
  for (const result of results) {
    if (result.status === 'analyzed') analyzed++;
    else if (result.status === 'filtered') filtered++;
    else if (result.status === 'failed') {
      failed++;
      failureReasons.push(result.reason);
    } else skipped++;
  }

  log(`====== 分析完成: ${analyzed} 收录, ${filtered} 过滤, ${skipped} 跳过, ${failed} 失败 ======`);
  return { analyzed, filtered, skipped, deferredSlow, laneSkipped, failed, failureReasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAnalyze(process.argv[2] || 'douyin-hotspot').catch(error => {
    console.error('分析失败:', error);
    process.exit(1);
  });
}
