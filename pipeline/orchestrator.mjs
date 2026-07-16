#!/usr/bin/env node
// ============================================================
//  hotvideo 管线编排器
//  用法:
//    node pipeline/orchestrator.mjs --source douyin-hotspot
//    node pipeline/orchestrator.mjs --all
//    node pipeline/orchestrator.mjs --source douyin-hotspot --skip-scrape --skip-publish
//
//  阶段:
//    scrape (source.scrape) → fetch → analyze → publish
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFetch } from './fetch.mjs';
import { runAnalyze } from './analyze.mjs';
import { runPublish } from './publish.mjs';

const args = process.argv.slice(2);
const SOURCES_DIR = path.resolve(import.meta.dirname, '..', 'sources');
export const PIPELINE_STAGES = Object.freeze(['scrape', 'fetch', 'analyze', 'publish']);

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`\n[${ts}] ${msg}`);
}

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const next = args[idx + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

function listAllSources() {
  if (!fs.existsSync(SOURCES_DIR)) return [];
  return fs.readdirSync(SOURCES_DIR).filter(d => {
    const indexFile = path.join(SOURCES_DIR, d, 'index.mjs');
    return fs.existsSync(indexFile);
  });
}

export function summarizeStageFailures(stageResults) {
  return (stageResults || [])
    .filter(item => Number(item?.result?.failed || 0) > 0)
    .map(item => ({ stage: item.stage, failed: Number(item.result.failed) }));
}

export function isRetryableAgyAnalyzeResult(result) {
  if (Number(result?.failed || 0) <= 0) return false;
  const text = (result?.failureReasons || []).map(item => String(item || '')).join('\n');
  if (!text) return false;
  return /hotvideo-agy|analysis\.json|timeout waiting for response|无法解析 JSON|JSON/.test(text);
}

export function shouldEscalateStageFailures(stageFailures, env = process.env) {
  return (stageFailures || []).length > 0
    && !/^(1|true|yes)$/i.test(String(env.HOTVIDEO_RESULT_ENVELOPE_MODE || ''));
}

export function isAgyAuthFailureResult(result) {
  if (Number(result?.failed || 0) <= 0) return false;
  const text = (result?.failureReasons || []).map(item => String(item || '')).join('\n');
  return /authentication failed|authentication timed out|auth timed out|keyringAuth/i.test(text);
}

function analyzeRetryCount() {
  const raw = Number.parseInt(process.env.HOTVIDEO_AGY_ANALYZE_RETRY_COUNT || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

function analyzeRetryDelayMs() {
  const raw = Number.parseInt(process.env.HOTVIDEO_AGY_ANALYZE_RETRY_DELAY_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30000;
}

export function agyRetryDelayMsForResult(result, env = process.env) {
  if (isAgyAuthFailureResult(result)) {
    const raw = Number.parseInt(env.HOTVIDEO_AGY_AUTH_RETRY_DELAY_MS || '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60000;
  }
  const raw = Number.parseInt(env.HOTVIDEO_AGY_ANALYZE_RETRY_DELAY_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : analyzeRetryDelayMs();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAnalyzeWithAgyRetry(sourceName) {
  const maxAttempts = analyzeRetryCount() + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      log(`>>> [${sourceName}] 3/4 分析重试 ${attempt}/${maxAttempts}`);
    }
    const result = await runAnalyze(sourceName);
    if (!isRetryableAgyAnalyzeResult(result)) {
      return result;
    }
    if (attempt >= maxAttempts) {
      return result;
    }
    const delayMs = agyRetryDelayMsForResult(result);
    const reason = isAgyAuthFailureResult(result) ? 'agy 登录态抖动' : 'agy 分析失败';
    log(`>>> [${sourceName}] ${reason}，${Math.round(delayMs / 1000)} 秒后重试`);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return { failed: 1, failureReasons: ['unreachable analyze retry state'] };
}

async function runAnalyzeWithRetry(sourceName) {
  const analyzer = (process.env.HOTVIDEO_ANALYZER || 'doubao').trim().toLowerCase();
  if (analyzer !== 'agy') {
    return runAnalyze(sourceName);
  }
  return runAnalyzeWithAgyRetry(sourceName);
}

async function loadSource(name) {
  const indexPath = path.join(SOURCES_DIR, name, 'index.mjs');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`source 不存在: ${name}（缺少 ${indexPath}）`);
  }
  const mod = await import(pathToFileURL(indexPath).href);
  return mod.default;
}

async function runOneSource(sourceName, flags) {
  log(`====== source: ${sourceName} ======`);
  const source = await loadSource(sourceName);
  const stageResults = [];

  if (!flags.skipScrape) {
    log(`>>> [${sourceName}] 1/4 抓取`);
    await source.scrape();
  } else {
    log(`>>> [${sourceName}] 1/4 跳过抓取`);
  }

  if (!flags.skipFetch) {
    log(`>>> [${sourceName}] 2/4 下载`);
    stageResults.push({ stage: 'fetch', result: await runFetch(sourceName) });
  } else {
    log(`>>> [${sourceName}] 2/4 跳过下载`);
  }

  if (!flags.skipAnalyze) {
    log(`>>> [${sourceName}] 3/4 分析`);
    stageResults.push({ stage: 'analyze', result: await runAnalyzeWithRetry(sourceName) });
  } else {
    log(`>>> [${sourceName}] 3/4 跳过分析`);
  }

  if (!flags.skipPublish) {
    log(`>>> [${sourceName}] 4/4 推送`);
    stageResults.push({ stage: 'publish', result: await runPublish(sourceName) });
  } else {
    log(`>>> [${sourceName}] 4/4 跳过推送`);
  }

  const stageFailures = summarizeStageFailures(stageResults);
  if (shouldEscalateStageFailures(stageFailures)) {
    throw new Error(`阶段存在单项失败: ${stageFailures.map(f => `${f.stage}=${f.failed}`).join(', ')}`);
  }
  if (stageFailures.length > 0) {
    log(`>>> [${sourceName}] 单项失败已交给 run-result 信封: ${stageFailures.map(f => `${f.stage}=${f.failed}`).join(', ')}`);
  }
}

async function main() {
  const dateWindow = getArg('--date-window');
  if (dateWindow && dateWindow !== true) {
    process.env.HOTVIDEO_DATE_WINDOW = String(dateWindow);
  }
  const categoryProfile = getArg('--category-profile');
  if (categoryProfile && categoryProfile !== true) {
    process.env.HOTVIDEO_CATEGORY_PROFILE = String(categoryProfile);
  }
  const limit = getArg('--limit');
  if (limit && limit !== true) {
    process.env.HOTVIDEO_LIMIT = String(limit);
  }
  const analyzer = getArg('--analyzer');
  if (analyzer && analyzer !== true) {
    process.env.HOTVIDEO_ANALYZER = String(analyzer);
  }
  const analyzeConcurrency = getArg('--analyze-concurrency');
  if (analyzeConcurrency && analyzeConcurrency !== true) {
    process.env.HOTVIDEO_ANALYZE_CONCURRENCY = String(analyzeConcurrency);
  }
  const analyzeLane = getArg('--analyze-lane');
  if (analyzeLane && analyzeLane !== true) {
    process.env.HOTVIDEO_ANALYZE_LANE = String(analyzeLane);
  }
  const analyzeLimit = getArg('--analyze-limit');
  if (analyzeLimit && analyzeLimit !== true) {
    process.env.HOTVIDEO_ANALYZE_LIMIT = String(analyzeLimit);
  }

  const flags = {
    skipScrape: args.includes('--skip-scrape'),
    skipFetch: args.includes('--skip-fetch'),
    skipAnalyze: args.includes('--skip-analyze'),
    skipPublish: args.includes('--skip-publish'),
  };

  let sources;
  if (args.includes('--all')) {
    sources = listAllSources();
    if (sources.length === 0) {
      console.error('没有发现任何 source（sources/ 下需有 <name>/index.mjs）');
      process.exit(1);
    }
  } else {
    const sourceArg = getArg('--source');
    if (!sourceArg || sourceArg === true) {
      console.error('用法: --source <name> 或 --all');
      console.error(`已知 source: ${listAllSources().join(', ') || '(无)'}`);
      process.exit(1);
    }
    sources = [sourceArg];
  }

  log(`====== 管线启动: ${sources.join(', ')} ======`);
  if (process.env.HOTVIDEO_DATE_WINDOW) {
    log(`运行参数: dateWindow=${process.env.HOTVIDEO_DATE_WINDOW}`);
  }
  if (process.env.HOTVIDEO_CATEGORY_PROFILE) {
    log(`运行参数: categoryProfile=${process.env.HOTVIDEO_CATEGORY_PROFILE}`);
  }
  if (process.env.HOTVIDEO_ANALYZER) {
    log(`运行参数: analyzer=${process.env.HOTVIDEO_ANALYZER}`);
  }
  if (process.env.HOTVIDEO_ANALYZE_CONCURRENCY) {
    log(`运行参数: analyzeConcurrency=${process.env.HOTVIDEO_ANALYZE_CONCURRENCY}`);
  }
  if (process.env.HOTVIDEO_ANALYZE_LANE) {
    log(`运行参数: analyzeLane=${process.env.HOTVIDEO_ANALYZE_LANE}`);
  }
  if (process.env.HOTVIDEO_ANALYZE_LIMIT) {
    log(`运行参数: analyzeLimit=${process.env.HOTVIDEO_ANALYZE_LIMIT}`);
  }
  if (process.env.HOTVIDEO_LIMIT) {
    log(`运行参数: limit=${process.env.HOTVIDEO_LIMIT}`);
  }
  const failures = [];
  for (const s of sources) {
    try {
      await runOneSource(s, flags);
    } catch (err) {
      console.error(`[${s}] 失败:`, err.message);
      failures.push({ source: s, error: err.message });
    }
  }
  log('====== 管线完成 ======');
  if (failures.length > 0) {
    console.error(`管线存在失败 source: ${failures.map(f => f.source).join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('编排器失败:', err);
    process.exit(1);
  });
}
