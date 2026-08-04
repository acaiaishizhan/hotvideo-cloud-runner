import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidates, normalizeClassification, shouldKeepCandidate } from './classifier.mjs';
import {
  existingYoutubeIdsFromResponses,
  discoverCandidates,
  filterCandidatesByPublishWindow,
  routeCandidatesForClassification,
  selectCandidatesForClassification,
  selectPendingCandidates,
} from './scrape.mjs';
import { hotScore, mergeCandidates } from './youtube-api.mjs';

test('mergeCandidates 合并同一视频的多路召回来源', () => {
  const result = mergeCandidates([
    [{ id: 'abc123', title: 'A', lanes: ['search:date'] }],
    [{ id: 'abc123', title: 'A2', lanes: ['channel:focused'] }],
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].lanes.sort(), ['channel:focused', 'search:date']);
  assert.equal(result[0].title, 'A2');
});

test('发布时间窗口覆盖两次任务之间的间隔并保留两小时重叠', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const result = filterCandidatesByPublishWindow([
    { id: '13h', publishedAt: '2026-08-03T23:00:00Z' },
    { id: '14h', publishedAt: '2026-08-03T22:00:00Z' },
    { id: '15h', publishedAt: '2026-08-03T21:00:00Z' },
    { id: 'future', publishedAt: '2026-08-04T12:01:00Z' },
    { id: 'missing' },
  ], { now, lookbackHours: 14 });
  assert.deepEqual(result.map(item => item.id), ['13h', '14h']);
});

test('搜索额度耗尽后停止搜索请求，但保留热门榜和重点频道候选', async () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  let searchCalls = 0;
  const api = {
    popularVideos: async () => [{ id: 'popular', publishedAt: '2026-08-04T11:00:00Z', lanes: ['popular:US:28'] }],
    channelUploads: async () => [{ id: 'focused', publishedAt: '2026-08-04T10:00:00Z', lanes: ['channel:focused'] }],
    searchVideos: async () => {
      searchCalls++;
      throw new Error('YouTube API search HTTP 429: Quota exceeded');
    },
    hydrateVideos: async items => items,
  };
  const result = await discoverCandidates(api, now);
  assert.equal(searchCalls, 1);
  assert.deepEqual(result.map(item => item.id).sort(), ['focused', 'popular']);
});

test('AI 议题保留，纯 AI 娱乐过滤，重点频道不确定项留给视频复审', () => {
  assert.equal(shouldKeepCandidate({ classification: { relation: 'ai_topic', confidence: 0.8 }, lanes: [] }), true);
  assert.equal(shouldKeepCandidate({ classification: { relation: 'ai_generated', confidence: 0.9 }, lanes: ['channel:focused'] }), false);
  assert.equal(shouldKeepCandidate({ classification: { relation: 'uncertain' }, lanes: ['channel:focused'] }), true);
  assert.equal(shouldKeepCandidate({ classification: { relation: 'uncertain' }, lanes: ['search:date'] }), false);
  assert.equal(shouldKeepCandidate({ classification: { relation: 'uncertain', failed: true }, lanes: ['search:date'] }), false);
  assert.equal(shouldKeepCandidate({ classification: { relation: 'uncertain', failed: true }, keepOnClassifierFailure: true, lanes: ['search:date'] }), true);
});

test('normalizeClassification 对非法模型输出收口', () => {
  assert.deepEqual(normalizeClassification({ relation: 'maybe', confidence: 3, reason: 'x' }), {
    relation: 'uncertain', confidence: 1, reason: 'x',
  });
});

test('分类请求失败后只重试一次并使用成功结果', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error('temporary');
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          items: [{ id: 'v1', relation: 'ai_topic', confidence: 0.9, reason: 'AI 模型发布' }],
        }) } }],
      }),
    };
  };
  const result = await classifyCandidates([{ id: 'v1', title: 'New model' }], {
    apiKey: 'test', fetchImpl, retries: 1, retryDelayMs: 0,
  });
  assert.equal(calls, 2);
  assert.equal(result[0].classification.relation, 'ai_topic');
});

test('批量连续失败后拆成单条，单条仍失败的候选保留复审标记', async () => {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    const hasGood = prompt.includes('"id":"good"');
    const hasBad = prompt.includes('"id":"bad"');
    if ((hasGood && hasBad) || hasBad) throw new Error('timeout');
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          items: [{ id: 'good', relation: 'ai_topic', confidence: 0.9, reason: 'ok' }],
        }) } }],
      }),
    };
  };
  const result = await classifyCandidates([
    { id: 'good', title: 'AI model' },
    { id: 'bad', title: 'unknown' },
  ], { apiKey: 'test', fetchImpl, batchSize: 2, retries: 0, retryDelayMs: 0 });
  assert.equal(result[0].classification.relation, 'ai_topic');
  assert.equal(result[1].classification.relation, 'uncertain');
  assert.equal(result[1].classification.failed, true);
  assert.equal(shouldKeepCandidate(result[1]), false);
});

test('定时抓取可整批超时降级，不逐条阻塞', async () => {
  let calls = 0;
  const result = await classifyCandidates([
    { id: 'clear', title: 'AI model', keepOnClassifierFailure: true },
    { id: 'weak', title: 'unknown', keepOnClassifierFailure: false },
  ], {
    apiKey: 'test',
    fetchImpl: async () => { calls++; throw new Error('timeout'); },
    batchSize: 8,
    retries: 0,
    allowSingleFallback: false,
    failOpen: true,
  });
  assert.equal(calls, 1);
  assert.equal(result[0].classification.failed, true);
  assert.equal(shouldKeepCandidate(result[0]), true);
  assert.equal(shouldKeepCandidate(result[1]), false);
});

test('飞书视频链接兼容 watch 与 youtu.be', () => {
  const ids = existingYoutubeIdsFromResponses([{
    data: {
      fields: ['视频链接'],
      data: [
        ['https://www.youtube.com/watch?v=abc123XYZ_-'],
        ['https://youtu.be/def456XYZ_-'],
      ],
    },
  }]);
  assert.deepEqual([...ids].sort(), ['abc123XYZ_-', 'def456XYZ_-']);
});

test('候选按热度选择并跳过飞书已有视频', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const candidates = [
    { id: 'old', publishedAt: '2026-08-04T10:00:00Z', viewCount: 1000, lanes: [], classification: { relation: 'ai_topic' } },
    { id: 'hot', publishedAt: '2026-08-04T11:00:00Z', viewCount: 100000, lanes: [], classification: { relation: 'ai_topic' } },
    { id: 'no', publishedAt: '2026-08-04T11:00:00Z', viewCount: 999999, lanes: [], classification: { relation: 'not_ai' } },
  ];
  assert.ok(hotScore(candidates[1], now) > hotScore(candidates[0], now));
  assert.deepEqual(selectPendingCandidates(candidates, { now, maxPending: 2, existingIds: new Set(['old']) }).map(item => item.id), ['hot']);
});

test('普通低播放视频不进热门清单，重点 AI 频道可例外', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const classification = { relation: 'ai_topic' };
  const selected = selectPendingCandidates([
    { id: 'weak', publishedAt: '2026-08-04T11:00:00Z', viewCount: 10, lanes: ['search:date'], classification },
    { id: 'focused', publishedAt: '2026-08-04T11:00:00Z', viewCount: 10, lanes: ['channel:focused'], classification },
  ], { now, minViewCount: 1000 });
  assert.deepEqual(selected.map(item => item.id), ['focused']);
});

test('分类预算优先保留重点 AI 频道，同时兼顾热门和最新', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const candidates = [
    { id: 'focused', publishedAt: '2026-08-03T12:00:00Z', viewCount: 1, lanes: ['channel:focused'] },
    { id: 'hot', publishedAt: '2026-08-04T11:00:00Z', viewCount: 100000, lanes: ['popular:US:28'] },
    { id: 'new', publishedAt: '2026-08-04T11:59:00Z', viewCount: 0, lanes: ['search:date'] },
  ];
  const selected = selectCandidatesForClassification(candidates, { now, maxClassify: 3 });
  assert.deepEqual(new Set(selected.map(item => item.id)), new Set(['focused', 'hot', 'new']));
});

test('明确 AI 议题和重点频道直接保留，纯 AI 娱乐仍交模型判断', () => {
  const routed = routeCandidatesForClassification([
    { id: 'focused', title: 'It finally happened', lanes: ['channel:focused'] },
    { id: 'topic', title: 'Anthropic releases a new Claude coding model', lanes: ['search:date'] },
    { id: 'entertainment', title: 'Funny AI baby animation #viral #aivideo', lanes: ['search:viewCount'] },
    { id: 'plain', title: 'Colored shadows explained', lanes: ['popular:US:28'] },
  ]);
  assert.deepEqual(new Set(routed.direct.keys()), new Set(['focused', 'topic']));
  assert.deepEqual(routed.needsModel.map(item => item.id), ['entertainment', 'plain']);
});

test('只有话题标签的泛内容不走规则直通', () => {
  const routed = routeCandidatesForClassification([{
    id: 'hashtag-only',
    title: 'India or China #motivation #facts #ai #chatgpt',
    description: '',
    tags: ['ai', 'chatgpt'],
    lanes: ['search:viewCount'],
  }]);
  assert.equal(routed.direct.size, 0);
  assert.equal(routed.needsModel.length, 1);
  assert.equal(routed.needsModel[0].keepOnClassifierFailure, false);
});
test('游戏角色 Claude 不按 AI 产品直通', () => {
  const routed = routeCandidatesForClassification([{
    id: 'game-claude',
    title: 'Claude is better than Granger #claude #mlbb #mobilelegends',
    description: '',
    tags: ['gaming'],
    lanes: ['search:date'],
  }]);
  assert.equal(routed.direct.size, 0);
  assert.equal(routed.needsModel[0].keepOnClassifierFailure, false);
});
