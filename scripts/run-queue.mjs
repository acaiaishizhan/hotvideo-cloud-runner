#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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

  const recoveryKeys = new Set();
  for (const [index, item] of value.items.entries()) {
    validateItem(item, `items[${index}]`);
    const key = recoveryKey(item, 'new-video');
    if (recoveryKeys.has(key)) throw new Error(`items[${index}].id 重复: ${item.id}`);
    recoveryKeys.add(key);
  }

  const repeatItems = value.repeatUpdates?.items;
  if (repeatItems !== undefined && !Array.isArray(repeatItems)) {
    throw new Error('manifest.repeatUpdates.items 必须是数组');
  }
  if ((repeatItems?.length || 0) > 5000) throw new Error('单批最多 5000 条重复更新');
  for (const [index, item] of (repeatItems || []).entries()) {
    validateItem(item, `repeatUpdates.items[${index}]`);
    const key = recoveryKey(item, 'interaction-update');
    if (recoveryKeys.has(key)) throw new Error(`recoveryKey 重复: ${key}`);
    recoveryKeys.add(key);
  }
  return value;
}

function validateItem(item, label) {
  const id = String(item?.id || '');
  if (!/^\d{8,32}$/.test(id)) throw new Error(`${label}.id 非法`);
  let url;
  try { url = new URL(String(item?.url || '')); } catch { throw new Error(`${label}.url 非法`); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`${label}.url 只允许 https://www.douyin.com`);
  }
}

function recoverAttempt(item) {
  const value = Number.parseInt(String(item?.recovery?.attempt ?? item?.recoverAttempt ?? 0), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function recoveryKey(item, operationKind) {
  return `${String(item?.id || '')}:${operationKind}`;
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
  const repeatPath = path.join(videosDir, 'repeat-updates.json');
  if (repeatItems.length > 0) {
    fs.writeFileSync(repeatPath, `${JSON.stringify({
      source: manifest.source,
      scrapedAt: manifest.repeatUpdates?.scrapedAt || manifest.scrapedAt,
      items: repeatItems,
    }, null, 2)}\n`, 'utf-8');
  } else if (fs.existsSync(repeatPath)) {
    fs.unlinkSync(repeatPath);
  }
  return { newItems: manifest.items.length, repeatItems: repeatItems.length };
}

export function manifestScope(manifest) {
  const contexts = [
    ...manifest.items.map(item => item?.context || {}),
    ...(manifest.repeatUpdates?.items || []).map(item => item?.scraped || {}),
  ];
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
  const required = ['ARK_API_KEY', 'HOTVIDEO_FEISHU_BASE_TOKEN', 'HOTVIDEO_FEISHU_TABLE_ID'];
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
  console.log('云端 fast 管线 attempt 1/1');
  const fast = await run(fastArgs);

  const slowArgs = buildPipelineArgs(manifest, scope, { lane: 'slow' });
  console.log('云端 slow 管线 attempt 1/1');
  const slow = await run(slowArgs);
  return { fast, slow };
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function errorSummaryForMeta(meta, errorClass) {
  return String(
    meta?.errorSummary
      || meta?.analysis_error
      || meta?.last_error
      || `${errorClass} 未达到终态`,
  ).slice(0, 500);
}

function newVideoOutcome(item, videosDir) {
  const meta = readJson(path.join(videosDir, String(item.id), 'meta.json'));
  const status = String(meta?.status || 'missing');
  const terminal = status === 'filtered'
    || (status === 'published' && meta?.attachment_uploaded !== false);
  const base = {
    recoveryKey: recoveryKey(item, 'new-video'),
    status: terminal ? 'success' : 'failure',
    recoverAttempt: recoverAttempt(item),
  };
  if (base.status === 'success') return base;
  const errorClass = status === 'missing' ? 'fetch' : status === 'new' ? 'analyze' : status === 'analyzed' ? 'publish' : 'pipeline';
  return {
    ...base,
    errorClass,
    errorSummary: errorSummaryForMeta(meta, errorClass),
    recoveryPayload: item,
  };
}

export function shouldFailRunResultEnvelope(envelope) {
  const successes = envelope.items.filter(item => item.status === 'success').length;
  return envelope.items.length > 0 && successes === 0;
}

export function collectRunResultItems(manifest, videosDir) {
  const remainingRepeat = new Set(
    (readJson(path.join(videosDir, 'repeat-updates.json'))?.items || []).map(item => recoveryKey(item, 'interaction-update')),
  );
  const items = manifest.items.map(item => newVideoOutcome(item, videosDir));
  for (const item of manifest.repeatUpdates?.items || []) {
    const key = recoveryKey(item, 'interaction-update');
    const base = { recoveryKey: key, recoverAttempt: recoverAttempt(item) };
    items.push(remainingRepeat.has(key)
      ? {
          ...base,
          status: 'failure',
          errorClass: 'publish',
          errorSummary: '互动更新未写入飞书，仍留在 repeat-updates.json',
          recoveryPayload: item,
        }
      : { ...base, status: 'success' });
  }
  return items;
}

export function buildRunResultEnvelope({
  manifest,
  queueFile,
  videosDir,
  env = process.env,
  startedAt,
  finishedAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: 1,
    runId: String(env.GITHUB_RUN_ID || 'local'),
    runAttempt: Number.parseInt(env.GITHUB_RUN_ATTEMPT || '1', 10) || 1,
    headSha: String(env.GITHUB_SHA || ''),
    queueFile,
    queueDigest: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    startedAt,
    finishedAt,
    items: collectRunResultItems(manifest, videosDir),
  };
}

export function validateRunResultEnvelope(value) {
  const required = ['schemaVersion', 'runId', 'runAttempt', 'headSha', 'queueFile', 'queueDigest', 'startedAt', 'finishedAt', 'items'];
  for (const key of required) {
    if (value?.[key] === undefined || value?.[key] === null) throw new Error(`run-result 缺少 ${key}`);
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.items)) throw new Error('run-result schema 非法');
  for (const [index, item] of value.items.entries()) {
    if (!item.recoveryKey || !['success', 'failure'].includes(item.status)) throw new Error(`run-result.items[${index}] 非法`);
    if (item.status === 'success' && ('recoveryPayload' in item || 'errorSummary' in item)) {
      throw new Error(`run-result.items[${index}] 成功项不得携带恢复 payload`);
    }
    if (item.status === 'failure' && (!item.recoveryPayload || !item.errorClass || !item.errorSummary)) {
      throw new Error(`run-result.items[${index}] 失败项恢复证据不完整`);
    }
  }
  return value;
}

function writeEnvelope(filePath, envelope) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(validateRunResultEnvelope(envelope), null, 2)}\n`, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const startedAt = new Date().toISOString();
  const queueArg = argv[0];
  if (!queueArg) throw new Error('用法: node scripts/run-queue.mjs queue/<run-id>.json');
  assertSecrets(env);

  const queuePath = path.resolve(ROOT, queueArg);
  const relative = path.relative(path.join(ROOT, 'queue'), queuePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('queue 文件必须位于 queue/ 顶层');
  }

  const manifest = validateManifest(JSON.parse(fs.readFileSync(queuePath, 'utf-8')));
  const scope = manifestScope(manifest);
  const videosDir = path.join(ROOT, 'videos', 'douyin-hotspot');
  const counts = materializeManifest(manifest, videosDir);
  console.log(`已装载队列: 新视频 ${counts.newItems} 条，重复更新 ${counts.repeatItems} 条`);

  process.env.HOTVIDEO_ANALYZER = 'doubao';
  process.env.HOTVIDEO_ANALYZE_LANE = 'fast';
  process.env.HOTVIDEO_ANALYZE_CONCURRENCY ||= '5';
  process.env.HOTVIDEO_FEISHU_IDENTITY = 'bot';
  process.env.HOTVIDEO_RESULT_ENVELOPE_MODE = '1';
  if (scope.categoryProfile) process.env.HOTVIDEO_CATEGORY_PROFILE = scope.categoryProfile;
  if (scope.dateWindow) process.env.HOTVIDEO_DATE_WINDOW = scope.dateWindow;

  console.log(`云端队列: ${queueArg}`);
  const phases = await runPipelinePhases(manifest, scope);
  const phaseFailure = ['fast', 'slow'].find(name => phases[name].code !== 0);
  if (phaseFailure) {
    throw phases[phaseFailure].error || new Error(`${phaseFailure} 管线阶段级失败，exitCode=${phases[phaseFailure].code}`);
  }

  const envelope = buildRunResultEnvelope({ manifest, queueFile: queueArg, videosDir, env, startedAt });
  const outputPath = path.resolve(ROOT, env.HOTVIDEO_RUN_RESULT_PATH || 'out/run-result.json');
  writeEnvelope(outputPath, envelope);
  const successes = envelope.items.filter(item => item.status === 'success').length;
  const failures = envelope.items.length - successes;
  console.log(`run-result 已持久化: ${successes} 成功, ${failures} 失败 → ${outputPath}`);
  if (shouldFailRunResultEnvelope(envelope)) {
    throw new Error('本 manifest 0 项成功，按阶段级故障退出');
  }
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
