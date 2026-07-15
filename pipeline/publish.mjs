#!/usr/bin/env node
// ============================================================
//  飞书多维表推送（平台无关）
//  用法: node publish.mjs <sourceName>
//  将 status=analyzed 的视频推送到飞书 Base，更新状态为 published
// ============================================================

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './json-file.mjs';
import { videoRecordKey } from './video-url.mjs';

const BASE_TOKEN = process.env.HOTVIDEO_FEISHU_BASE_TOKEN || '';
const TABLE_ID = process.env.HOTVIDEO_FEISHU_TABLE_ID || '';
const LARK_IDENTITY = process.env.HOTVIDEO_FEISHU_IDENTITY || 'bot';
const FULL_VIDEO_COPY_FIELD = '完整视频文案';
const INTERACTION_FIELDS = [
  {
    name: '评论数',
    json: {
      type: 'number',
      name: '评论数',
      style: { type: 'plain', precision: 0, percentage: false, thousands_separator: true },
    },
  },
  {
    name: '分享数',
    json: {
      type: 'number',
      name: '分享数',
      style: { type: 'plain', precision: 0, percentage: false, thousands_separator: true },
    },
  },
];
const LARK_CLI_BIN = process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli';
const LARK_MAX_BUFFER = 64 * 1024 * 1024;

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function runLimit() {
  const n = Number.parseInt(process.env.HOTVIDEO_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatDuration(sec) {
  const totalSec = Math.round(sec || 0);
  const min = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatPublishTime(ts) {
  if (!ts) return null;
  const num = Number(ts);
  if (!num) return null;
  const d = new Date(num * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const PLATFORM_MAP = {
  douyin: '抖音',
  bilibili: 'B站',
  youtube: 'YouTube',
};

const DATE_WINDOW_LABELS = {
  1: '近1小时',
  24: '近1天',
  72: '近3天',
  168: '近7天',
};

async function loadSourceConfig(sourceName) {
  const configPath = path.resolve(import.meta.dirname, '..', 'sources', sourceName, 'config.mjs');
  if (!fs.existsSync(configPath)) {
    throw new Error(`source 配置不存在: ${configPath}`);
  }
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default;
}

function formatDateWindowLabel(value) {
  if (value == null || value === '') return '';
  const key = String(value);
  return DATE_WINDOW_LABELS[key] || `近${key}小时`;
}

function sourceTypeFromMeta(meta) {
  const scraped = meta.scraped || {};
  if (scraped.sourceType || scraped.category || scraped.type) {
    return scraped.sourceType || scraped.category || scraped.type;
  }
  if (meta.source === 'douyin-hotspot') return '科技/科技科普';
  return '';
}

function sourceTypeForProfile(config, profileName) {
  if (!profileName) return '';
  return config.categoryProfiles?.[profileName]?.label || '';
}

function activePublishScope(config, env = process.env) {
  const profileName = env.HOTVIDEO_CATEGORY_PROFILE || '';
  if (!profileName) return null;
  const sourceType = sourceTypeForProfile(config, profileName);
  return {
    sourceType,
    dateWindow: env.HOTVIDEO_DATE_WINDOW || '',
  };
}

export function shouldPublishMetaInScope(meta, scope) {
  if (!scope) return true;
  const scraped = meta.scraped || {};
  if (scope.sourceType && sourceTypeFromMeta(meta) !== scope.sourceType) return false;
  if (scope.dateWindow && String(scraped.dateWindow ?? meta.dateWindow ?? '') !== String(scope.dateWindow)) return false;
  return true;
}

function billboardNamesFromMeta(meta) {
  const billboards = meta.scraped?.billboards || meta.billboards || [];
  return billboards
    .map(item => typeof item === 'string' ? item : item?.name)
    .filter(Boolean);
}

function normalizeLikeRate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed);
    if (!Number.isFinite(n)) return null;
    return trimmed.endsWith('%') ? n / 100 : n;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function likeRateFromMeta(meta) {
  const scraped = meta.scraped || {};
  return normalizeLikeRate(
    scraped.likeRate
      ?? scraped.like_rate
      ?? meta.metrics?.like_rate
      ?? meta.metrics?.likeRate
      ?? meta.stats?.likeRate
      ?? meta.stats?.like_rate
  );
}

export function resolvePublishedRecordRepair(meta, existingRecordId) {
  const recordId = existingRecordId || meta?.feishu_record_id || '';
  return {
    recordId,
    shouldRepair: !existingRecordId,
    createNew: !existingRecordId,
  };
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function setPositiveNumber(record, fieldName, ...values) {
  const value = firstPositiveNumber(...values);
  if (value > 0) record[fieldName] = value;
}

export function buildInteractionUpdateRecord(meta) {
  const stats = meta?.stats || {};
  const metrics = meta?.metrics || {};
  const scraped = meta?.scraped || {};
  const hotspotDetail = scraped.hotspotDetail || {};
  const isDouyinHotspot = meta?.source === 'douyin-hotspot' || Object.keys(hotspotDetail).length > 0;
  const record = {};

  if (isDouyinHotspot) {
    setPositiveNumber(record, '点赞数', hotspotDetail.likeCount);
    setPositiveNumber(record, '评论数', hotspotDetail.commentCount);
    setPositiveNumber(record, '分享数', hotspotDetail.shareCount);
  } else {
    setPositiveNumber(record, '点赞数', stats.likeCount, metrics.like_count, metrics.likeCount, scraped.likeCount, scraped.like_count);
    setPositiveNumber(record, '评论数', stats.commentCount, metrics.comment_count, metrics.commentCount, scraped.commentCount, scraped.comment_count);
    setPositiveNumber(record, '分享数', stats.shareCount, metrics.share_count, metrics.shareCount, scraped.shareCount, scraped.share_count);
  }

  const likeRate = likeRateFromMeta(meta);
  if (likeRate > 0) record['点赞率'] = likeRate;

  return record;
}

// 兼容新 camelCase 和旧 snake_case 两种 meta schema
export function buildRecord(meta) {
  const a = meta.analysis || {};
  const scraped = meta.scraped || {};
  const author = typeof meta.author === 'object' && meta.author !== null
    ? (meta.author.name || '')
    : (meta.author || '');
  const durationSec = meta.durationSec
    ?? (typeof meta.duration === 'number' ? Math.round(meta.duration / 1000) : 0);
  const publishedAt = meta.publishedAt ?? meta.publish_time;
  const platform = meta.platform || (meta.source?.startsWith('douyin') ? 'douyin' : '');
  const record = {
    '标题': meta.title || '',
    '视频链接': meta.url || '',
    '平台': PLATFORM_MAP[platform] || platform || '其他',
    '类型': sourceTypeFromMeta(meta),
    '榜单': billboardNamesFromMeta(meta),
    '时间段': formatDateWindowLabel(scraped.dateWindow ?? meta.dateWindow),
    '作者': author,
    '发布时间': formatPublishTime(publishedAt),
    '视频时长': formatDuration(durationSec),
    '一句话总结': a.summary || '',
    '内容类型': a.content_type || '',
    '主题': Array.isArray(a.topics) ? a.topics : [],
    '标签': Array.isArray(a.tags) ? a.tags : [],
    '开头钩子': a.hook || '',
    '爆点原因': a.viral_reason || '',
    '可模仿角度': a.imitation_angle || '',
    [FULL_VIDEO_COPY_FIELD]: a.full_video_copy || '',
  };

  Object.assign(record, buildInteractionUpdateRecord(meta));
  return record;
}

export function buildRepeatUpdateRecord(meta) {
  const full = buildRecord(meta);
  const refreshFields = [
    '标题',
    '视频链接',
    '平台',
    '类型',
    '榜单',
    '时间段',
    '点赞数',
    '点赞率',
    '评论数',
    '分享数',
  ];
  const record = {};

  for (const key of refreshFields) {
    const value = full[key];
    if (value == null) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    record[key] = value;
  }

  return record;
}

function winCmdQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function larkExecArgs(args, timeout = 30000) {
  const result = process.platform === 'win32'
    ? execSync([LARK_CLI_BIN, ...args].map(winCmdQuote).join(' '), { encoding: 'utf-8', timeout, maxBuffer: LARK_MAX_BUFFER })
    : execFileSync(LARK_CLI_BIN, args, { encoding: 'utf-8', timeout, maxBuffer: LARK_MAX_BUFFER });
  return JSON.parse(result);
}

function larkExecJsonArgs(args, payload, timeout = 30000) {
  // lark-cli --json @file 要求 cwd 下的相对路径，和 record-upsert 保持同一策略。
  const tmpName = `.hotvideo-lark-json-${process.pid}-${Date.now()}.json`;
  fs.writeFileSync(tmpName, JSON.stringify(payload), 'utf-8');
  try {
    return larkExecArgs([...args, '--json', `@${tmpName}`], timeout);
  } finally {
    try { fs.unlinkSync(tmpName); } catch (_) {}
  }
}

export function ensureFullVideoCopyField() {
  const resp = larkExecArgs([
    'base',
    '+field-list',
    '--base-token', BASE_TOKEN,
    '--table-id', TABLE_ID,
    '--as', LARK_IDENTITY,
    '--format', 'json',
  ]);
  const fields = resp.data?.fields || [];
  if (fields.some(field => field?.name === FULL_VIDEO_COPY_FIELD)) return;

  larkExecJsonArgs([
    'base',
    '+field-create',
    '--base-token', BASE_TOKEN,
    '--table-id', TABLE_ID,
    '--as', LARK_IDENTITY,
  ], {
    type: 'text',
    name: FULL_VIDEO_COPY_FIELD,
    description: '从视频口播、人声旁白转写得到的完整视频文案；无口播时留空',
  });
}

export function ensureInteractionFields() {
  const resp = larkExecArgs([
    'base',
    '+field-list',
    '--base-token', BASE_TOKEN,
    '--table-id', TABLE_ID,
    '--as', LARK_IDENTITY,
    '--format', 'json',
  ]);
  const existingNames = new Set((resp.data?.fields || []).map(field => field?.name).filter(Boolean));

  for (const field of INTERACTION_FIELDS) {
    if (existingNames.has(field.name)) continue;
    larkExecJsonArgs([
      'base',
      '+field-create',
      '--base-token', BASE_TOKEN,
      '--table-id', TABLE_ID,
      '--as', LARK_IDENTITY,
    ], field.json);
    log(`已创建互动字段: ${field.name}`);
  }
}

// 返回 Map<url, record_id>。url 用 markdown 解出来的纯净 URL。
export function loadExistingRecords() {
  log('加载飞书已有记录...');
  const map = new Map();
  let offset = 0;
  const limit = 200;

  while (true) {
    const resp = larkExecArgs([
      'base',
      '+record-list',
      '--base-token', BASE_TOKEN,
      '--table-id', TABLE_ID,
      '--as', LARK_IDENTITY,
      '--format', 'json',
      '--field-id', '视频链接',
      '--limit', String(limit),
      '--offset', String(offset),
    ]);
    if (!resp.ok || !resp.data?.data) break;

    const urlIdx = resp.data.fields.indexOf('视频链接');
    const recordIds = resp.data.record_id_list || [];
    for (let i = 0; i < resp.data.data.length; i++) {
      const row = resp.data.data[i];
      const rid = recordIds[i];
      if (urlIdx !== -1 && row[urlIdx] && rid) {
        let rawUrl = row[urlIdx];
        const mdMatch = rawUrl.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (mdMatch) rawUrl = mdMatch[2];
        const key = videoRecordKey(rawUrl);
        if (key) map.set(key, rid);
      }
    }

    if (!resp.data.has_more) break;
    offset += limit;
  }

  log(`  已有 ${map.size} 条记录`);
  return map;
}

function larkUpsert(record, recordId = '') {
  const args = [
    'base',
    '+record-upsert',
    '--base-token', BASE_TOKEN,
    '--table-id', TABLE_ID,
    '--as', LARK_IDENTITY,
  ];
  if (recordId) args.push('--record-id', recordId);
  return larkExecJsonArgs(args, record);
}

export function updateFeishuRecordFields(recordId, fields) {
  return larkUpsert(fields, recordId);
}

// 飞书 record-upsert 返回结构里的 record_id 实际在 record_id_list[0]
function extractRecordId(resp) {
  const list = resp?.data?.record?.record_id_list;
  if (Array.isArray(list) && list.length > 0) return list[0];
  return null;
}

// 大文件用 lark-cli 自带的 multipart，超时给宽点（156MB 约需 1-2 分钟）
// lark-cli 1.0.23 的 --file 只接受 cwd 下的相对路径，所以先 chdir 到视频目录再调用
function larkUploadAttachment(recordId, fieldId, filePath) {
  const absPath = path.resolve(filePath);
  const fileDir = path.dirname(absPath);
  const fileName = path.basename(absPath);
  const cwdBefore = process.cwd();
  try {
    process.chdir(fileDir);
    return larkExecArgs([
      'base',
      '+record-upload-attachment',
      '--base-token', BASE_TOKEN,
      '--table-id', TABLE_ID,
      '--as', LARK_IDENTITY,
      '--record-id', recordId,
      '--field-id', fieldId,
      '--file', `./${fileName}`,
    ], 600000);
  } finally {
    process.chdir(cwdBefore);
  }
}

export function isAttachmentUploadAccepted(resp) {
  if (!resp?.ok) return false;
  if (Array.isArray(resp.data?.ignored_fields) && resp.data.ignored_fields.length > 0) return false;
  return hasAttachmentFiles(resp.data?.attachments);
}

function hasAttachmentFiles(value) {
  if (!value) return false;
  if (Array.isArray(value)) {
    return value.some(item => item?.file_token || item?.name);
  }
  if (typeof value === 'object') {
    return Object.values(value).some(hasAttachmentFiles);
  }
  return false;
}

function attachmentUploadError(resp) {
  const ignored = resp?.data?.ignored_fields;
  if (Array.isArray(ignored) && ignored.length > 0) {
    return ignored.map(field => `${field.name || field.id}: ${field.reason || 'ignored'}`).join('; ');
  }
  if (resp?.ok) return 'upload response has no attachment data';
  return JSON.stringify(resp).substring(0, 200);
}

export async function uploadAttachmentWithRetry(uploadFn, opts = {}) {
  const attempts = Math.max(1, Number.parseInt(String(opts.attempts || 3), 10));
  const delayMs = Math.max(0, Number.parseInt(String(opts.delayMs ?? 15_000), 10));
  const isAccepted = opts.isAccepted || (() => true);
  const sleepImpl = opts.sleepImpl || sleep;
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      lastResponse = await uploadFn();
      if (isAccepted(lastResponse)) return { ok: true, response: lastResponse, attempt };
      lastError = new Error(opts.responseError?.(lastResponse) || '附件上传响应未被接受');
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts && delayMs > 0) await sleepImpl(delayMs);
  }
  return { ok: false, response: lastResponse, error: lastError, attempts };
}

export async function runPublish(sourceName) {
  if (!BASE_TOKEN || !TABLE_ID) {
    throw new Error('缺少 HOTVIDEO_FEISHU_BASE_TOKEN 或 HOTVIDEO_FEISHU_TABLE_ID');
  }
  if (!['bot', 'user'].includes(LARK_IDENTITY)) {
    throw new Error(`不支持的 HOTVIDEO_FEISHU_IDENTITY: ${LARK_IDENTITY}`);
  }
  const config = await loadSourceConfig(sourceName);
  const videosDir = config.videosDir;
  const repeatUpdatePath = path.join(videosDir, 'repeat-updates.json');
  const scope = activePublishScope(config);

  log(`====== 飞书推送开始 [${sourceName}] ======`);
  if (scope) {
    log(`发布范围: sourceType=${scope.sourceType || '(未识别)'}, dateWindow=${scope.dateWindow || '(不限)'}`);
  }

  ensureFullVideoCopyField();
  ensureInteractionFields();
  const existingRecords = loadExistingRecords();

  const dirs = fs.readdirSync(videosDir).filter(d => {
    const metaPath = path.join(videosDir, d, 'meta.json');
    return fs.existsSync(metaPath);
  });

  let published = 0;
  let skipped = 0;
  let deduped = 0;
  let updated = 0;
  let failed = 0;
  let attachmentsUploaded = 0;
  let processed = 0;
  const limit = runLimit();

  // 给指定 record 上传视频附件，幂等：已上传过则跳过
  async function tryUploadAttachment(meta, recordId, videoDir) {
    if (!config.feishuAttachmentField) return true;
    if (meta.attachment_uploaded === true) return true;

    const videoPath = meta.files?.videoPath
      ? path.resolve(meta.files.videoPath)
      : path.join(videoDir, 'video.mp4');
    if (!fs.existsSync(videoPath)) return true;

    log(`  上传视频附件 → ${config.feishuAttachmentField}`);
    const result = await uploadAttachmentWithRetry(
      () => larkUploadAttachment(recordId, config.feishuAttachmentField, videoPath),
      {
        attempts: process.env.HOTVIDEO_FEISHU_ATTACHMENT_ATTEMPTS || 3,
        delayMs: process.env.HOTVIDEO_FEISHU_ATTACHMENT_RETRY_DELAY_MS || 15_000,
        isAccepted: isAttachmentUploadAccepted,
        responseError: attachmentUploadError,
      },
    );
    if (!result.ok) {
      log(`  ⚠ 附件上传最终失败: ${result.error?.message || '未知错误'}`);
      meta.attachment_uploaded = false;
      failed++;
      return false;
    }
    meta.attachment_uploaded = true;
    attachmentsUploaded++;
    return true;
  }

  if (fs.existsSync(repeatUpdatePath)) {
    const repeatUpdates = JSON.parse(fs.readFileSync(repeatUpdatePath, 'utf-8'));
    const remainingRepeatItems = [];
    for (const item of repeatUpdates.items || []) {
      const rid = existingRecords.get(videoRecordKey(item.url));
      if (!rid) {
        skipped++;
        log(`  重复更新跳过（飞书未找到记录）: ${(item.title || item.id || '').substring(0, 40)}...`);
        continue;
      }

      const record = buildRepeatUpdateRecord(item);
      if (Object.keys(record).length === 0) {
        skipped++;
        continue;
      }

      try {
        const resp = larkUpsert(record, rid);
        if (!resp.ok) {
          failed++;
          remainingRepeatItems.push(item);
          log(`  重复更新失败: ${JSON.stringify(resp).substring(0, 200)}`);
          continue;
        }
        updated++;
        log(`  重复更新完成 record_id=${rid}: ${(item.title || '').substring(0, 40)}...`);
      } catch (err) {
        failed++;
        remainingRepeatItems.push(item);
        log(`  重复更新异常: ${err.message}`);
      }
    }

    if (remainingRepeatItems.length > 0) {
      writeJsonAtomic(repeatUpdatePath, {
        ...repeatUpdates,
        items: remainingRepeatItems,
        updatedAt: new Date().toISOString(),
      });
    } else {
      fs.unlinkSync(repeatUpdatePath);
    }
  }

  for (const dir of dirs) {
    const metaPath = path.join(videosDir, dir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const videoDir = path.join(videosDir, dir);

    // 已 published 的：补 record_id + 补附件（之前没上传过）
    if (meta.status === 'published') {
      if (limit) {
        skipped++;
        continue;
      }
      const recordKey = videoRecordKey(meta.url);
      const existingRid = existingRecords.get(recordKey);
      if (existingRid && !meta.feishu_record_id) {
        meta.feishu_record_id = existingRid;
      }
      const repair = resolvePublishedRecordRepair(meta, existingRid);
      let rid = repair.recordId;
      if (repair.shouldRepair) {
        try {
          const resp = larkUpsert(buildRecord(meta));
          if (!resp.ok) {
            failed++;
            log(`  修复空记录失败: ${JSON.stringify(resp).substring(0, 200)}`);
            continue;
          }
          const createdRecordId = extractRecordId(resp);
          if (!createdRecordId) {
            failed++;
            log(`  修复空记录失败: 未拿到新 record_id, resp=${JSON.stringify(resp).substring(0, 200)}`);
            continue;
          }
          rid = createdRecordId;
          meta.feishu_record_id = createdRecordId;
          meta.attachment_uploaded = false;
          existingRecords.set(recordKey, rid);
          updated++;
          log(`  已重建缺失记录 old_record_id=${repair.recordId || '(无)'} new_record_id=${rid}: ${(meta.title || '').substring(0, 40)}...`);
        } catch (err) {
          failed++;
          log(`  修复空记录异常: ${err.message}`);
          continue;
        }
      }
      if (rid && config.feishuAttachmentField && meta.attachment_uploaded !== true) {
        log(`补附件: ${(meta.title || '').substring(0, 40)}...`);
        await tryUploadAttachment(meta, rid, videoDir);
        writeJsonAtomic(metaPath, meta);
      } else if (repair.shouldRepair) {
        writeJsonAtomic(metaPath, meta);
      }
      if (!repair.shouldRepair) skipped++;
      continue;
    }

    if (meta.status !== 'analyzed') {
      skipped++;
      continue;
    }
    if (!shouldPublishMetaInScope(meta, scope)) {
      skipped++;
      continue;
    }
    if (limit && processed >= limit) {
      skipped++;
      continue;
    }
    processed++;

    const recordKey = videoRecordKey(meta.url);
    if (existingRecords.has(recordKey)) {
      const rid = existingRecords.get(recordKey);
      try {
        const resp = larkUpsert(buildRecord(meta), rid);
        if (!resp.ok) {
          failed++;
          log(`  更新已有记录失败: ${JSON.stringify(resp).substring(0, 200)}`);
          continue;
        }
        meta.status = 'published';
        meta.published_to_feishu = true;
        meta.feishu_record_id = rid;
        await tryUploadAttachment(meta, rid, videoDir);
        writeJsonAtomic(metaPath, meta);
        deduped++;
        updated++;
        log(`  更新已有记录 record_id=${rid}: ${(meta.title || '').substring(0, 40)}...`);
        continue;
      } catch (err) {
        failed++;
        log(`  更新已有记录异常: ${err.message}`);
        continue;
      }
    }

    log(`推送: ${(meta.title || '').substring(0, 50)}...`);

    try {
      const record = buildRecord(meta);
      const resp = larkUpsert(record);

      if (!resp.ok) {
        failed++;
        log(`  失败: ${JSON.stringify(resp).substring(0, 200)}`);
        continue;
      }

      const recordId = extractRecordId(resp);
      if (!recordId) {
        failed++;
        log(`  失败: 未拿到 record_id, resp=${JSON.stringify(resp).substring(0, 200)}`);
        continue;
      }

      meta.feishu_record_id = recordId;
      await tryUploadAttachment(meta, recordId, videoDir);

      meta.status = 'published';
      meta.published_to_feishu = true;
      meta.published_at = new Date().toISOString();
      writeJsonAtomic(metaPath, meta);
      existingRecords.set(recordKey, recordId);
      published++;
      log(`  完成 record_id=${recordId}`);
    } catch (err) {
      failed++;
      log(`  失败: ${err.message}`);
    }
  }

  log(`====== 推送完成: ${published} 新增, ${updated} 更新, ${deduped} 去重, ${skipped} 跳过, ${failed} 失败 | 附件 ${attachmentsUploaded} 上传 ======`);
  return { published, updated, deduped, skipped, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceName = process.argv[2] || 'douyin-hotspot';
  runPublish(sourceName).catch(err => {
    console.error('推送失败:', err);
    process.exit(1);
  });
}
