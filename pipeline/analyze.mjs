#!/usr/bin/env node
// ============================================================
//  WSL agy 视频分析（平台无关）
//  用法: node analyze.mjs <sourceName>
//  分析 status=new 的视频，更新 meta.json 中的 analysis 字段
// ============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './json-file.mjs';
import {
  buildSystemPromptForMeta,
  USER_PROMPT_TEMPLATE,
  CONTENT_TYPES,
  TOPICS,
} from './prompt.mjs';
import {
  hasFullVideoCopy,
  isValidVideoFile,
  mergeFullVideoCopy,
  resolveVideoPath,
} from './transcribe-video-copy.mjs';
import {
  mapWithConcurrency,
  transcriptMetaFromResult,
  transcribeVideoCopyAuto,
} from './video-copy-provider.mjs';
import { analyzeVideoWithDoubao } from './doubao-analyzer.mjs';
import { prepareAnalysisVideoProxy } from './analysis-video-proxy.mjs';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_AGY_TIMEOUT_MS = 360000;
const DEFAULT_AGY_CWD_WSL = '/home/openclaw';
const DEFAULT_AGY_MODEL = 'Gemini 3.1 Pro (High)';
const DEFAULT_SLOW_VIDEO_DURATION_SEC = 600;
const DEFAULT_SLOW_VIDEO_BYTES = 32 * 1024 * 1024;

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function runLimit() {
  const n = Number.parseInt(process.env.HOTVIDEO_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function analyzeLimit() {
  const n = Number.parseInt(process.env.HOTVIDEO_ANALYZE_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : runLimit();
}

function needsVideoCopy(meta) {
  return !hasFullVideoCopy(meta) && meta.transcript?.status !== 'done';
}

export function resolveAnalyzerProvider(env = process.env) {
  const provider = (env.HOTVIDEO_ANALYZER || 'doubao').trim().toLowerCase();
  if (provider === 'doubao' || provider === 'agy') return provider;
  throw new Error(`不支持的 HOTVIDEO_ANALYZER: ${provider}`);
}

export function resolveAnalyzeConcurrency(env = process.env, analyzer = resolveAnalyzerProvider(env)) {
  const raw = Number.parseInt(env.HOTVIDEO_ANALYZE_CONCURRENCY || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return analyzer === 'doubao' ? 5 : 1;
}

export function resolveAnalyzeLane(env = process.env) {
  const lane = (env.HOTVIDEO_ANALYZE_LANE || 'fast').trim().toLowerCase();
  if (lane === 'fast' || lane === 'slow' || lane === 'all') return lane;
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
  return durationSec > thresholds.durationSec || videoBytes > thresholds.videoBytes
    ? 'slow'
    : 'fast';
}

function formatDuration(sec) {
  const totalSec = Math.round(sec || 0);
  const min = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export function toWslPath(inputPath) {
  const normalized = String(inputPath).replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

async function loadSourceConfig(sourceName) {
  const configPath = path.resolve(import.meta.dirname, '..', 'sources', sourceName, 'config.mjs');
  if (!fs.existsSync(configPath)) {
    throw new Error(`source 配置不存在: ${configPath}`);
  }
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default;
}

// 兼容两种 schema：
//   - 当前: camelCase（fetch.mjs 写出，meta.scraped.billboards / meta.author.name / meta.stats.viewCount 等）
//   - 早期: snake_case（早期 scrape 直写的 11 条存量，meta.billboards / meta.author 字符串 / meta.metrics.play_count）
function readMeta(meta) {
  const billboards = meta.scraped?.billboards || meta.billboards || [];
  const author = typeof meta.author === 'object' && meta.author !== null
    ? meta.author.name || ''
    : (meta.author || '');
  const scraped = meta.scraped || {};
  const view = firstPositiveNumber(
    meta.stats?.viewCount,
    meta.metrics?.play_count,
    meta.metrics?.playCount,
    scraped.playCount,
    scraped.play_count,
  );
  const like = firstPositiveNumber(
    meta.stats?.likeCount,
    meta.metrics?.like_count,
    meta.metrics?.likeCount,
    scraped.likeCount,
    scraped.like_count,
  );
  // 新格式 durationSec 是秒；旧格式 duration 是毫秒
  const durationSec = meta.durationSec
    ?? (typeof meta.duration === 'number' ? Math.round(meta.duration / 1000) : 0);
  const fullVideoCopy = typeof meta.analysis?.full_video_copy === 'string'
    ? meta.analysis.full_video_copy
    : '';
  return { author, view, like, durationSec, billboards, fullVideoCopy };
}

export function buildUserPrompt(meta) {
  const m = readMeta(meta);
  const bbNames = m.billboards.map(b => b.name).join('、') || '无';
  const fullVideoCopy = m.fullVideoCopy.trim()
    ? m.fullVideoCopy.trim().slice(0, 6000)
    : '无';
  return USER_PROMPT_TEMPLATE
    .replace('{title}', meta.title || '')
    .replace('{author}', m.author)
    .replace('{play_count}', m.view)
    .replace('{like_count}', m.like)
    .replace('{duration_text}', formatDuration(m.durationSec))
    .replace('{billboard_names}', bbNames)
    .replace('{full_video_copy}', fullVideoCopy);
}

function buildAgyPrompt({ videoPathWsl, meta, outputPathWsl }) {
  return [
    buildSystemPromptForMeta(meta),
    '',
    `你必须先读取并分析这个本地视频文件: ${videoPathWsl}`,
    '',
    buildUserPrompt(meta),
    '',
    '只把一个合法 JSON 对象写入下面这个 UTF-8 文本文件。',
    '不要输出 markdown 代码块，不要输出解释文字，不要把结果只写到 stdout。',
    `输出文件: ${outputPathWsl}`,
    '',
    '为了证明你确实读取了视频，请在 JSON 中额外加入 read_evidence 字段，用一句话写出你看见或听见的具体内容。',
  ].join('\n');
}

export function extractJsonObject(rawText) {
  const text = String(rawText || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`无法解析 JSON: ${text.substring(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function normalizeAgyAnalysis(result) {
  if (typeof result?.relevant !== 'boolean') {
    throw new Error('分析结果 relevant 必须是 boolean');
  }
  const normalized = {
    relevant: result.relevant,
    filter_reason: asString(result?.filter_reason),
    summary: asString(result?.summary),
    content_type: asString(result?.content_type),
    topics: asStringArray(result?.topics),
    tags: asStringArray(result?.tags),
    hook: asString(result?.hook),
    viral_reason: asString(result?.viral_reason),
    imitation_angle: asString(result?.imitation_angle),
    read_evidence: asString(result?.read_evidence),
    full_video_copy: asString(result?.full_video_copy),
  };

  if (!CONTENT_TYPES.includes(normalized.content_type)) {
    normalized.content_type = '其他';
  }

  normalized.topics = normalized.topics.filter(t => TOPICS.includes(t));
  if (normalized.topics.length === 0) normalized.topics = ['其他'];

  return normalized;
}

export function normalizeDoubaoAnalysis(result) {
  if (typeof result?.has_spoken_audio !== 'boolean') {
    throw new Error('Doubao 分析结果 has_spoken_audio 必须是 boolean');
  }

  const normalized = {
    ...normalizeAgyAnalysis(result),
    has_spoken_audio: result.has_spoken_audio,
  };

  if (!normalized.has_spoken_audio) {
    normalized.relevant = false;
    normalized.filter_reason = '无有效口播';
    normalized.full_video_copy = '';
    return normalized;
  }

  if (!normalized.full_video_copy.trim()) {
    throw new Error('Doubao 标记存在口播，但 full_video_copy 为空');
  }

  return normalized;
}

export function buildInvalidVideoMeta(meta, videoPath, now = new Date().toISOString()) {
  return {
    ...meta,
    has_video: false,
    status: 'filtered',
    filteredAt: now,
    analysis: {
      relevant: false,
      filter_reason: `本地 video.mp4 缺失或无效，跳过视频分析: ${videoPath}`,
      summary: meta.title || '历史缺失视频记录',
      content_type: '其他',
      topics: ['其他'],
      tags: ['缺失视频'],
      hook: '',
      viral_reason: '',
      imitation_angle: '',
      read_evidence: '未读取视频：本地 video.mp4 缺失或小于 1KB。',
      full_video_copy: typeof meta.analysis?.full_video_copy === 'string' ? meta.analysis.full_video_copy : '',
    },
  };
}

export function resolveAgyCwd(env = process.env) {
  return (env.HOTVIDEO_AGY_CWD || DEFAULT_AGY_CWD_WSL).trim();
}

export function resolveAgyModel(env = process.env) {
  return (env.HOTVIDEO_AGY_MODEL || DEFAULT_AGY_MODEL).trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildAgyShellScript({
  promptPathWsl,
  outputPathWsl,
  logPathWsl,
  stdoutPathWsl,
  stderrPathWsl,
  timeoutSec,
  model,
}) {
  const modelLine = model ? `agy_cmd+=(--model ${shellQuote(model)})` : '';
  return [
    'set -euo pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    `prompt="$(cat ${shellQuote(promptPathWsl)})"`,
    'agy_pid=""',
    'cleanup() {',
    '  if test -n "${agy_pid:-}" && kill -0 "$agy_pid" 2>/dev/null; then',
    '    kill "$agy_pid" 2>/dev/null || true',
    '    wait "$agy_pid" 2>/dev/null || true',
    '  fi',
    '}',
    'trap cleanup INT TERM',
    'agy_cmd=(agy -p "$prompt")',
    modelLine,
    `agy_cmd+=(--print-timeout ${shellQuote(`${timeoutSec}s`)})`,
    `agy_cmd+=(--log-file ${shellQuote(logPathWsl)})`,
    'agy_cmd+=(--dangerously-skip-permissions)',
    `"${'${agy_cmd[@]}'}" > ${shellQuote(stdoutPathWsl)} 2> ${shellQuote(stderrPathWsl)} &`,
    'agy_pid=$!',
    `for i in $(seq 1 ${shellQuote(timeoutSec)}); do`,
    `  if test -s ${shellQuote(outputPathWsl)}; then`,
    '    trap - INT TERM',
    '    kill "$agy_pid" 2>/dev/null || true',
    '    wait "$agy_pid" 2>/dev/null || true',
    '    exit 0',
    '  fi',
    '  if ! kill -0 "$agy_pid" 2>/dev/null; then',
    '    agy_status=0',
    '    wait "$agy_pid" || agy_status=$?',
    `    if test -s ${shellQuote(outputPathWsl)}; then exit 0; fi`,
    `    if test -s ${shellQuote(stdoutPathWsl)}; then cp ${shellQuote(stdoutPathWsl)} ${shellQuote(outputPathWsl)}; exit 0; fi`,
    '    exit "$agy_status"',
    '  fi',
    '  sleep 1',
    'done',
    'cleanup',
    `if test -s ${shellQuote(stdoutPathWsl)}; then cp ${shellQuote(stdoutPathWsl)} ${shellQuote(outputPathWsl)}; fi`,
    `test -s ${shellQuote(outputPathWsl)}`,
  ].join('\n');
}

function runAgyPrompt({ promptPath, outputPath, logPath, stdoutPath, stderrPath, timeoutMs }) {
  const timeoutSec = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const promptPathWsl = toWslPath(promptPath);
  const outputPathWsl = toWslPath(outputPath);
  const logPathWsl = toWslPath(logPath);
  const stdoutPathWsl = toWslPath(stdoutPath);
  const stderrPathWsl = toWslPath(stderrPath);
  const cwdWsl = resolveAgyCwd();
  const scriptPath = path.join(path.dirname(promptPath), 'run.sh');
  const scriptPathWsl = toWslPath(scriptPath);
  const script = buildAgyShellScript({
    promptPathWsl,
    outputPathWsl,
    logPathWsl,
    stdoutPathWsl,
    stderrPathWsl,
    timeoutSec,
    model: resolveAgyModel(),
  });
  fs.writeFileSync(scriptPath, `${script}\n`, 'utf-8');

  execFileSync('wsl.exe', [
    '--cd',
    cwdWsl,
    '--',
    'bash',
    scriptPathWsl,
  ], {
    encoding: 'utf-8',
    timeout: timeoutMs + 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readTail(filePath, maxChars = 1600) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

async function analyzeVideo(videoDir, meta) {
  const videoPath = meta.files?.videoPath
    ? path.resolve(meta.files.videoPath)
    : path.join(videoDir, 'video.mp4');
  if (!fs.existsSync(videoPath)) {
    log(`  跳过，视频文件不存在: ${videoPath}`);
    return null;
  }

  const tempParent = path.join(WORKSPACE_ROOT, 'temp', 'hotvideo-agy');
  fs.mkdirSync(tempParent, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempParent, 'run-'));
  const promptPath = path.join(tempDir, 'prompt.txt');
  const outputPath = path.join(tempDir, 'analysis.json');
  const logPath = path.join(tempDir, 'agy.log');
  const stdoutPath = path.join(tempDir, 'stdout.txt');
  const stderrPath = path.join(tempDir, 'stderr.txt');
  const timeoutMs = Number(process.env.HOTVIDEO_AGY_TIMEOUT_MS || DEFAULT_AGY_TIMEOUT_MS);

  const prompt = buildAgyPrompt({
    videoPathWsl: toWslPath(videoPath),
    meta,
    outputPathWsl: toWslPath(outputPath),
  });
  fs.writeFileSync(promptPath, prompt, 'utf-8');

  try {
    runAgyPrompt({ promptPath, outputPath, logPath, stdoutPath, stderrPath, timeoutMs });
    const rawText = fs.readFileSync(outputPath, 'utf-8');
    return normalizeAgyAnalysis(extractJsonObject(rawText));
  } catch (err) {
    const parts = [
      ['agy log', readTail(logPath)],
      ['stdout', readTail(stdoutPath)],
      ['stderr', readTail(stderrPath)],
    ].filter(([, text]) => text);
    const detail = parts.length
      ? ` | ${parts.map(([name, text]) => `${name}: ${text}`).join(' | ')}`
      : '';
    throw new Error(`${err.message}${detail}`);
  } finally {
    if (process.env.HOTVIDEO_KEEP_AGY_TEMP !== '1') {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function analyzeVideoByProvider(videoDir, meta, provider) {
  if (provider === 'doubao') {
    const output = await analyzeVideoWithDoubao(videoDir, meta);
    const analysis = normalizeDoubaoAnalysis(output.result);
    analysis.filter_reason = analysis.relevant ? '' : analysis.filter_reason;
    return {
      analysis,
      runtime: output.runtime,
      transcript: {
        ...(meta.transcript || {}),
        status: 'done',
        transcribedAt: new Date().toISOString(),
        provider: output.runtime.provider,
        model: output.runtime.model,
        audioAccess: analysis.has_spoken_audio,
      },
    };
  }

  let workingMeta = meta;
  if (needsVideoCopy(workingMeta)) {
    const transcript = await transcribeVideoCopyAuto(videoDir, workingMeta, { provider: 'whisper' });
    workingMeta = mergeFullVideoCopy(workingMeta, transcript.fullVideoCopy, {
      ...transcriptMetaFromResult(transcript),
    });
  }

  const analysis = await analyzeVideo(videoDir, workingMeta);
  if (analysis && typeof workingMeta.analysis?.full_video_copy === 'string') {
    analysis.full_video_copy = workingMeta.analysis.full_video_copy;
  }
  return {
    analysis,
    runtime: { provider: 'agy' },
    transcript: workingMeta.transcript,
  };
}

export async function runAnalyze(sourceName) {
  const config = await loadSourceConfig(sourceName);
  const videosDir = config.videosDir;
  const analyzer = resolveAnalyzerProvider();
  const concurrency = resolveAnalyzeConcurrency(process.env, analyzer);
  const lane = resolveAnalyzeLane();
  const laneThresholds = resolveAnalyzeLaneThresholds();

  log(`====== 视频分析开始 [${sourceName}] analyzer=${analyzer} concurrency=${concurrency} lane=${lane} ======`);

  const dirs = fs.readdirSync(videosDir).filter(d => {
    const metaPath = path.join(videosDir, d, 'meta.json');
    return fs.existsSync(metaPath);
  });

  let analyzed = 0;
  let filtered = 0;
  let skipped = 0;
  let failed = 0;
  let deferredSlow = 0;
  let laneSkipped = 0;
  const failureReasons = [];
  const limit = analyzeLimit();
  const targets = [];

  for (const dir of dirs) {
    const metaPath = path.join(videosDir, dir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

    if (meta.status !== 'new') {
      skipped++;
      continue;
    }
    if (limit && targets.length >= limit) {
      skipped++;
      continue;
    }

    const videoDir = path.join(videosDir, dir);
    const videoPath = resolveVideoPath(videoDir, meta);
    let videoBytes = 0;
    try {
      videoBytes = fs.statSync(videoPath).size;
    } catch { /* invalid files stay in the fast lane for terminal filtering */ }
    const itemLane = classifyAnalyzeLane(meta, videoBytes, laneThresholds);
    if (lane !== 'all' && itemLane !== lane) {
      if (lane === 'fast' && itemLane === 'slow') deferredSlow++;
      else laneSkipped++;
      continue;
    }

    targets.push({ dir, metaPath, meta, videoDir, videoPath, videoBytes, itemLane });
  }

  log(`分析候选: ${targets.length} 条，慢车道延后 ${deferredSlow} 条，其他车道跳过 ${laneSkipped} 条`);

  const processItem = async ({ metaPath, meta, videoDir, videoPath, videoBytes, itemLane }) => {
    const startedAt = Date.now();
    const durationSec = readMeta(meta).durationSec;
    const profile = `lane=${itemLane} duration=${formatDuration(durationSec)} size=${(videoBytes / 1024 / 1024).toFixed(1)}MB`;
    log(`分析: ${(meta.title || '').substring(0, 50)}... (${profile})`);
    try {
      if (!isValidVideoFile(videoPath)) {
        const nextMeta = buildInvalidVideoMeta(meta, videoPath);
        writeJsonAtomic(metaPath, nextMeta);
        log(`  过滤: ${nextMeta.analysis.filter_reason}`);
        return { status: 'filtered' };
      }

      let analysisMeta = meta;
      let proxyRuntime = null;
      if (analyzer === 'doubao' && itemLane === 'slow' && process.env.HOTVIDEO_ANALYZE_PROXY_ENABLED !== '0') {
        log(`  生成长视频分析副本: ${profile}`);
        proxyRuntime = prepareAnalysisVideoProxy(videoPath, durationSec);
        log(`  分析副本${proxyRuntime.cached ? '命中缓存' : '生成完成'}: ${(proxyRuntime.proxyBytes / 1024 / 1024).toFixed(1)}MB`);
        analysisMeta = {
          ...meta,
          files: {
            ...(meta.files || {}),
            videoPath: proxyRuntime.path,
          },
        };
      }

      const { analysis, runtime, transcript } = await analyzeVideoByProvider(videoDir, analysisMeta, analyzer);
      if (analysis) {
        const elapsedMs = Date.now() - startedAt;
        meta.analysis = analysis;
        if (transcript) meta.transcript = transcript;
        meta.analyzed_at = new Date().toISOString();
        meta.analyzer = analyzer;
        meta.analysisRuntime = {
          ...(runtime || {}),
          lane: itemLane,
          durationSec,
          videoBytes,
          elapsedMs,
          ...(proxyRuntime ? {
            proxy: {
              cached: proxyRuntime.cached,
              sourceBytes: proxyRuntime.sourceBytes,
              proxyBytes: proxyRuntime.proxyBytes,
            },
          } : {}),
        };

        if (analysis.relevant === false) {
          meta.status = 'filtered';
          log(`  过滤 [${(elapsedMs / 1000).toFixed(1)}s]: ${analysis.filter_reason || '不符合收录标准'}`);
          writeJsonAtomic(metaPath, meta);
          return { status: 'filtered' };
        } else {
          meta.status = 'analyzed';
          log(`  完成 [${(elapsedMs / 1000).toFixed(1)}s]: ${analysis.summary}`);
          writeJsonAtomic(metaPath, meta);
          return { status: 'analyzed' };
        }
      }

      return { status: 'skipped' };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      log(`  失败 [${(elapsedMs / 1000).toFixed(1)}s] (${profile}): ${err.message}`);
      return { status: 'failed', reason: String(err?.message || err) };
    }
  };

  const results = await mapWithConcurrency(targets, concurrency, processItem);
  for (const result of results) {
    if (result?.status === 'analyzed') analyzed++;
    else if (result?.status === 'filtered') filtered++;
    else if (result?.status === 'failed') {
      failed++;
      failureReasons.push(result.reason);
    } else {
      skipped++;
    }
  }

  log(`====== 分析完成: ${analyzed} 收录, ${filtered} 过滤, ${skipped} 跳过, ${deferredSlow} 慢车道延后, ${failed} 失败 ======`);
  return { analyzed, filtered, skipped, deferredSlow, laneSkipped, failed, failureReasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceName = process.argv[2] || 'douyin-hotspot';
  runAnalyze(sourceName).catch(err => {
    console.error('分析失败:', err);
    process.exit(1);
  });
}
