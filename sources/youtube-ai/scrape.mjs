#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../../pipeline/json-file.mjs';
import config from './config.mjs';
import { classifyCandidates, shouldKeepCandidate } from './classifier.mjs';
import { ageHours, hotScore, mergeCandidates, YouTubeApi } from './youtube-api.mjs';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function log(message) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${message}`);
}

function readEnvValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(WORKSPACE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find(item => item.trimStart().startsWith(`${name}=`));
  return line?.split('=', 2)[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function youtubeIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (url.hostname.endsWith('youtube.com')) return url.searchParams.get('v') || '';
  } catch { /* ignore */ }
  return '';
}

export function existingYoutubeIdsFromResponses(responses) {
  const ids = new Set();
  for (const response of responses || []) {
    const fields = response?.data?.fields || [];
    const urlIndex = fields.indexOf('视频链接');
    if (urlIndex === -1) continue;
    for (const row of response?.data?.data || []) {
      const id = youtubeIdFromUrl(row?.[urlIndex]);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function loadExistingYoutubeIds() {
  const token = process.env.HOTVIDEO_FEISHU_BASE_TOKEN;
  const tableId = process.env.HOTVIDEO_FEISHU_TABLE_ID;
  if (!token || !tableId) return new Set();
  const bin = process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli';
  const identity = process.env.HOTVIDEO_FEISHU_IDENTITY || (process.platform === 'win32' ? 'user' : 'bot');
  const responses = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const raw = execFileSync(bin, [
      'base', '+record-list', '--base-token', token, '--table-id', tableId,
      '--as', identity, '--format', 'json', '--field-id', '视频链接',
      '--limit', String(limit), '--offset', String(offset),
    ], { encoding: 'utf-8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
    const response = JSON.parse(raw);
    responses.push(response);
    if (!response?.ok || !response?.data?.has_more) break;
  }
  return existingYoutubeIdsFromResponses(responses);
}

export function selectPendingCandidates(candidates, {
  now = Date.now(),
  maxPending = 30,
  minViewCount = 1000,
  existingIds = new Set(),
} = {}) {
  return (candidates || [])
    .filter(item => !existingIds.has(item.id))
    .filter(shouldKeepCandidate)
    .filter(item => item.lanes?.includes('channel:focused') || item.viewCount >= minViewCount)
    .sort((a, b) => hotScore(b, now) - hotScore(a, now))
    .slice(0, maxPending);
}

export function selectCandidatesForClassification(candidates, {
  now = Date.now(),
  maxClassify = 60,
} = {}) {
  const selected = new Map();
  const add = item => {
    if (item?.id && selected.size < maxClassify) selected.set(item.id, item);
  };
  const focused = (candidates || [])
    .filter(item => item.lanes?.includes('channel:focused'))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  focused.forEach(add);

  const remaining = (candidates || []).filter(item => !selected.has(item.id));
  remaining
    .filter(item => item.lanes?.some(lane => lane.startsWith('search:')))
    .sort((a, b) => hotScore(b, now) - hotScore(a, now))
    .slice(0, Math.ceil(maxClassify * 0.45))
    .forEach(add);
  remaining
    .filter(item => item.lanes?.some(lane => lane.startsWith('popular:')))
    .sort((a, b) => hotScore(b, now) - hotScore(a, now))
    .slice(0, Math.ceil(maxClassify * 0.3))
    .forEach(add);
  [...remaining]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .forEach(add);
  return [...selected.values()];
}

export function routeCandidatesForClassification(candidates) {
  const direct = new Map();
  const needsModel = [];
  const strongEntity = /\b(openai|anthropic|chatgpt|claude|deepseek|grok|qwen|codex|llm|large language model|artificial intelligence|machine learning|generative ai)\b/i;
  const aiSubject = /\b(ai|agi)\b.{0,40}\b(model|agent|robot|coding|chip|safety|research|news|tool|video generator|policy|regulation|bubble)\b|\b(model|agent|robot|coding|chip|safety|research|news|tool|video generator|policy|regulation|bubble)\b.{0,40}\b(ai|agi)\b/i;
  const entertainment = /#?(funny|comedy|challenge|viral|aivideo|aishorts|asmr|meme|song|music|baby|babies|animation|shortdrama|gaming|gameplay|mobilelegends|mlbb|moba)/i;
  const explanatory = /\b(review|explained|analysis|tutorial|course|guide|learn|release|launch|news|research|paper|benchmark|policy|warning|business|developer|prompt|how to)\b/i;

  for (const candidate of candidates || []) {
    const title = String(candidate.title || '');
    const titleWithoutHashtags = title.replace(/#[^\s#]+/g, ' ');
    const text = [title, candidate.description, ...(candidate.tags || [])].join(' ');
    const focused = candidate.lanes?.includes('channel:focused');
    const clearAiTopic = strongEntity.test(titleWithoutHashtags) || aiSubject.test(titleWithoutHashtags);
    const looksLikeEntertainment = entertainment.test(text) && !explanatory.test(text);
    if (focused || (clearAiTopic && !looksLikeEntertainment)) {
      direct.set(candidate.id, {
        ...candidate,
        classification: {
          relation: 'ai_topic',
          confidence: focused ? 0.86 : 0.82,
          reason: focused
            ? '重点 AI 频道的新视频，先保留给完整视频复审'
            : '标题本身出现明确 AI 实体或议题，先保留给完整视频复审',
          route: 'rule',
        },
      });
    } else {
      needsModel.push({
        ...candidate,
        keepOnClassifierFailure: clearAiTopic && !looksLikeEntertainment,
      });
    }
  }
  return { direct, needsModel };
}

export function filterCandidatesByPublishWindow(candidates, {
  now = Date.now(),
  lookbackHours = config.discoveryWindowHours,
} = {}) {
  const earliest = now - lookbackHours * 3600000;
  return (candidates || []).filter(candidate => {
    const publishedAt = Date.parse(candidate.publishedAt || '');
    return Number.isFinite(publishedAt) && publishedAt >= earliest && publishedAt <= now;
  });
}

async function discoverCandidates(api, now) {
  const discoveryHours = integerEnv('HOTVIDEO_YOUTUBE_WINDOW_HOURS', config.discoveryWindowHours);
  const popularHours = integerEnv('HOTVIDEO_YOUTUBE_POPULAR_WINDOW_HOURS', config.popularWindowHours);
  const publishedAfter = new Date(now - discoveryHours * 3600000).toISOString();
  const groups = [];

  for (const regionCode of config.regionCodes) {
    for (const categoryId of config.popularCategoryIds) {
      try {
        const items = await api.popularVideos({ categoryId, regionCode });
        groups.push(items.filter(item => ageHours(item, now) <= popularHours));
      } catch (error) {
        log(`跳过不可用热门榜: region=${regionCode} category=${categoryId} (${error.message})`);
      }
    }
  }

  for (const channel of config.seedChannels) {
    try {
      const items = await api.channelUploads({
        channel,
        maxResults: integerEnv('HOTVIDEO_YOUTUBE_CHANNEL_ITEMS', config.channelItemsPerRun),
      });
      groups.push(items.filter(item => ageHours(item, now) <= discoveryHours));
    } catch (error) {
      log(`跳过不可用频道: ${channel.title} (${error.message})`);
    }
  }

  for (const regionCode of config.regionCodes) {
    for (const query of config.searchQueries) {
      groups.push(await api.searchVideos({ query, publishedAfter, order: 'date', regionCode }));
      groups.push(await api.searchVideos({ query, publishedAfter, order: 'viewCount', regionCode }));
    }
  }

  const hydrated = await api.hydrateVideos(mergeCandidates(groups));
  return filterCandidatesByPublishWindow(hydrated, { now, lookbackHours: discoveryHours });
}

export async function runScrape({ now = Date.now(), api, classify = classifyCandidates } = {}) {
  log('====== YouTube AI 候选抓取开始 ======');
  const youtubeApi = api || new YouTubeApi({ apiKey: readEnvValue('YOUTUBE_API_KEY') });
  const candidates = await discoverCandidates(youtubeApi, now);
  log(`多路召回并补齐元数据: ${candidates.length} 条`);

  const classifyTargets = selectCandidatesForClassification(candidates, {
    now,
    maxClassify: integerEnv('HOTVIDEO_YOUTUBE_MAX_CLASSIFY', config.maxClassify),
  });
  log(`进入文本分类: ${classifyTargets.length} 条（重点频道全保留，其余兼顾热度与新鲜度）`);
  const routed = routeCandidatesForClassification(classifyTargets);
  log(`规则可确定: ${routed.direct.size} 条；交给模型复判: ${routed.needsModel.length} 条`);
  const modelClassified = routed.needsModel.length > 0
    ? await classify(routed.needsModel, {
        batchSize: integerEnv('HOTVIDEO_YOUTUBE_CLASSIFIER_BATCH_SIZE', config.classifierBatchSize),
        timeoutMs: integerEnv('HOTVIDEO_YOUTUBE_CLASSIFIER_TIMEOUT_MS', config.classifierTimeoutMs),
        retries: 0,
        allowSingleFallback: false,
        failOpen: true,
      })
    : [];
  const modelById = new Map(modelClassified.map(item => [item.id, item]));
  const classified = classifyTargets.map(item => routed.direct.get(item.id) || modelById.get(item.id));
  const relationCounts = Object.groupBy(classified, item => item.classification?.relation || 'uncertain');
  log(`AI 文本分类: ${Object.entries(relationCounts).map(([key, items]) => `${key}=${items.length}`).join(', ')}`);

  let existingIds = new Set();
  try {
    existingIds = loadExistingYoutubeIds();
    if (existingIds.size > 0) log(`飞书前置去重: 已有 ${existingIds.size} 个 YouTube 视频`);
  } catch (error) {
    log(`飞书前置去重失败，继续依赖发布阶段去重: ${error.message}`);
  }

  const maxPending = integerEnv('HOTVIDEO_YOUTUBE_MAX_PENDING', config.maxPending);
  const selected = selectPendingCandidates(classified, {
    now,
    maxPending,
    minViewCount: integerEnv('HOTVIDEO_YOUTUBE_MIN_VIEW_COUNT', config.minViewCount),
    existingIds,
  });
  const pending = {
    source: 'youtube-ai',
    scrapedAt: new Date(now).toISOString(),
    items: selected.map((item, index) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      billboards: item.lanes.map(name => ({ name, rank: index + 1 })),
      context: {
        sourceType: config.sourceType,
        dateWindow: integerEnv('HOTVIDEO_DATE_WINDOW', config.dateWindowHours),
        discoveryLanes: item.lanes,
        channelId: item.channelId,
        channelTitle: item.channelTitle,
        publishedAt: item.publishedAt,
        playCount: item.viewCount,
        likeCount: item.likeCount,
        commentCount: item.commentCount,
        viewsPerHour: Math.round(item.viewCount / Math.max(1, ageHours(item, now))),
        aiRelation: item.classification.relation,
        aiConfidence: item.classification.confidence,
        aiReason: item.classification.reason,
      },
    })),
  };

  fs.mkdirSync(config.videosDir, { recursive: true });
  writeJsonAtomic(path.join(config.videosDir, 'pending.json'), pending);
  writeJsonAtomic(path.join(config.videosDir, 'discovery-report.json'), {
    generatedAt: pending.scrapedAt,
    candidateCount: candidates.length,
    classifyTargetCount: classifyTargets.length,
    classifiedCount: classified.length,
    selectedCount: selected.length,
    relationCounts: Object.fromEntries(Object.entries(relationCounts).map(([key, items]) => [key, items.length])),
    selected: selected.map(item => ({
      id: item.id,
      title: item.title,
      channel: item.channelTitle,
      publishedAt: item.publishedAt,
      viewCount: item.viewCount,
      lanes: item.lanes,
      classification: item.classification,
    })),
    reviewSample: [...classified]
      .sort((a, b) => hotScore(b, now) - hotScore(a, now))
      .slice(0, 80)
      .map(item => ({
        id: item.id,
        title: item.title,
        channel: item.channelTitle,
        publishedAt: item.publishedAt,
        viewCount: item.viewCount,
        lanes: item.lanes,
        classification: item.classification,
      })),
  });
  log(`待处理清单: ${selected.length} 条 → ${path.join(config.videosDir, 'pending.json')}`);
  return { candidates, classified, selected, pending };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScrape().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
