import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgyShellScript,
  buildUserPrompt,
  buildInvalidVideoMeta,
  classifyAnalyzeLane,
  extractJsonObject,
  normalizeAgyAnalysis,
  normalizeDoubaoAnalysis,
  resolveAnalyzeConcurrency,
  resolveAnalyzeLane,
  resolveAnalyzeLaneThresholds,
  resolveAnalyzerProvider,
  resolveAgyCwd,
  resolveAgyModel,
  toWslPath,
} from './analyze.mjs';

test('toWslPath converts Windows paths for WSL agy', () => {
  assert.equal(
    toWslPath('C:\\Users\\24599\\Downloads\\标注成片_60s.mp4'),
    '/mnt/c/Users/24599/Downloads/标注成片_60s.mp4'
  );
  assert.equal(
    toWslPath('F:/coding/solo-company/hotvideo/videos/douyin-hotspot/abc/video.mp4'),
    '/mnt/f/coding/solo-company/hotvideo/videos/douyin-hotspot/abc/video.mp4'
  );
});

test('normalizeAgyAnalysis extracts JSON and clamps invalid categories', () => {
  const raw = [
    '这里是说明文字',
    '```json',
    '{',
    '  "relevant": false,',
    '  "filter_reason": "不是 AI 内容",',
    '  "summary": "男子讲短视频赚钱",',
    '  "content_type": "网赚",',
    '  "topics": ["副业"],',
    '  "tags": "短视频",',
    '  "hook": "有手就行",',
    '  "viral_reason": "低门槛赚钱诱饵",',
    '  "imitation_angle": "痛点加利益点开场"',
    '}',
    '```',
  ].join('\n');

  const result = normalizeAgyAnalysis(extractJsonObject(raw));

  assert.equal(result.relevant, false);
  assert.equal(result.filter_reason, '不是 AI 内容');
  assert.equal(result.content_type, '其他');
  assert.deepEqual(result.topics, ['其他']);
  assert.deepEqual(result.tags, []);
});

test('normalizeAgyAnalysis preserves full video copy text', () => {
  const result = normalizeAgyAnalysis({
    relevant: true,
    summary: '摘要',
    content_type: '工具教程',
    topics: ['AI编程'],
    tags: [],
    full_video_copy: '大家好，今天演示一个 AI 编程工作流。',
  });

  assert.equal(result.full_video_copy, '大家好，今天演示一个 AI 编程工作流。');
});

test('normalizeAgyAnalysis defaults missing or invalid full video copy to empty string', () => {
  assert.equal(normalizeAgyAnalysis({ relevant: true, full_video_copy: ['不是字符串'] }).full_video_copy, '');
  assert.equal(normalizeAgyAnalysis({ relevant: true }).full_video_copy, '');
});

test('normalizeAgyAnalysis rejects missing or non-boolean relevant values', () => {
  assert.throws(() => normalizeAgyAnalysis({}), /relevant 必须是 boolean/);
  assert.throws(() => normalizeAgyAnalysis({ relevant: 'false' }), /relevant 必须是 boolean/);
});

test('normalizeDoubaoAnalysis filters videos explicitly marked as having no spoken audio', () => {
  const result = normalizeDoubaoAnalysis({
    has_spoken_audio: false,
    relevant: true,
    filter_reason: '',
    summary: '纯画面展示',
    full_video_copy: '',
  });

  assert.equal(result.has_spoken_audio, false);
  assert.equal(result.relevant, false);
  assert.equal(result.filter_reason, '无有效口播');
  assert.equal(result.full_video_copy, '');
});

test('normalizeDoubaoAnalysis requires an explicit spoken-audio mark', () => {
  assert.throws(
    () => normalizeDoubaoAnalysis({ relevant: true, full_video_copy: '有口播' }),
    /has_spoken_audio 必须是 boolean/,
  );
  assert.throws(
    () => normalizeDoubaoAnalysis({ has_spoken_audio: 'false', relevant: false, full_video_copy: '' }),
    /has_spoken_audio 必须是 boolean/,
  );
});

test('normalizeDoubaoAnalysis rejects an empty transcript when spoken audio is present', () => {
  assert.throws(
    () => normalizeDoubaoAnalysis({ has_spoken_audio: true, relevant: true, full_video_copy: '   ' }),
    /full_video_copy 为空/,
  );
});

test('normalizeDoubaoAnalysis preserves a valid spoken transcript', () => {
  const result = normalizeDoubaoAnalysis({
    has_spoken_audio: true,
    relevant: true,
    filter_reason: '不应保留',
    full_video_copy: '这是一段有效口播。',
  });

  assert.equal(result.has_spoken_audio, true);
  assert.equal(result.relevant, true);
  assert.equal(result.full_video_copy, '这是一段有效口播。');
});

test('buildUserPrompt falls back to scraped counts when parsed stats counts are zero', () => {
  const prompt = buildUserPrompt({
    title: '热点页有播放量',
    author: { name: '作者' },
    stats: { viewCount: 0, likeCount: 0 },
    scraped: {
      playCount: 75028,
      likeCount: 3000,
      billboards: [{ name: '视频总榜' }],
    },
  });

  assert.match(prompt, /播放量：75028/);
  assert.match(prompt, /点赞数：3000/);
});

test('buildAgyShellScript embeds explicit paths instead of positional args', () => {
  const script = buildAgyShellScript({
    promptPathWsl: '/mnt/f/work/temp/prompt.txt',
    outputPathWsl: '/mnt/f/work/temp/analysis.json',
    logPathWsl: '/mnt/f/work/temp/agy.log',
    stdoutPathWsl: '/mnt/f/work/temp/stdout.txt',
    stderrPathWsl: '/mnt/f/work/temp/stderr.txt',
    timeoutSec: '360',
    model: 'Gemini 3.1 Pro (High)',
  });

  assert.match(script, /cat '\/mnt\/f\/work\/temp\/prompt\.txt'/);
  assert.match(script, /--model 'Gemini 3\.1 Pro \(High\)'/);
  assert.match(script, /--print-timeout '360s'/);
  assert.match(script, /test -s '\/mnt\/f\/work\/temp\/analysis\.json'/);
  assert.match(script, /> '\/mnt\/f\/work\/temp\/stdout\.txt' 2> '\/mnt\/f\/work\/temp\/stderr\.txt'/);
  assert.match(script, /cp '\/mnt\/f\/work\/temp\/stdout\.txt' '\/mnt\/f\/work\/temp\/analysis\.json'/);
  assert.match(script, /agy_pid=\$!/);
  assert.match(script, /kill "\$agy_pid"/);
  assert.doesNotMatch(script, /&;/);
  assert.doesNotMatch(script, /do;/);
  assert.doesNotMatch(script, /\$1|\$2|\$3|\$4/);
});

test('resolveAgyCwd isolates agy from the repository by default', () => {
  assert.equal(resolveAgyCwd({}), '/home/openclaw');
  assert.equal(resolveAgyCwd({ HOTVIDEO_AGY_CWD: '/tmp/hotvideo-agy' }), '/tmp/hotvideo-agy');
});

test('resolveAgyModel defaults to high model and remains overridable', () => {
  assert.equal(resolveAgyModel({}), 'Gemini 3.1 Pro (High)');
  assert.equal(resolveAgyModel({ HOTVIDEO_AGY_MODEL: 'Gemini 3.5 Flash (Medium)' }), 'Gemini 3.5 Flash (Medium)');
});

test('resolveAnalyzerProvider defaults to doubao with parallel analysis', () => {
  assert.equal(resolveAnalyzerProvider({}), 'doubao');
  assert.equal(resolveAnalyzerProvider({ HOTVIDEO_ANALYZER: 'agy' }), 'agy');
  assert.equal(resolveAnalyzeConcurrency({}, 'doubao'), 5);
  assert.equal(resolveAnalyzeConcurrency({}, 'agy'), 1);
  assert.equal(resolveAnalyzeConcurrency({ HOTVIDEO_ANALYZE_CONCURRENCY: '7' }, 'doubao'), 7);
});

test('analysis defaults to the fast lane and accepts explicit slow/all lanes', () => {
  assert.equal(resolveAnalyzeLane({}), 'fast');
  assert.equal(resolveAnalyzeLane({ HOTVIDEO_ANALYZE_LANE: 'slow' }), 'slow');
  assert.equal(resolveAnalyzeLane({ HOTVIDEO_ANALYZE_LANE: 'ALL' }), 'all');
  assert.throws(
    () => resolveAnalyzeLane({ HOTVIDEO_ANALYZE_LANE: 'unknown' }),
    /HOTVIDEO_ANALYZE_LANE/,
  );
});

test('analysis lane classifies long duration or large file as slow', () => {
  const thresholds = resolveAnalyzeLaneThresholds({});
  assert.equal(thresholds.durationSec, 600);
  assert.equal(thresholds.videoBytes, 32 * 1024 * 1024);

  assert.equal(classifyAnalyzeLane({ durationSec: 599 }, 1024, thresholds), 'fast');
  assert.equal(classifyAnalyzeLane({ durationSec: 601 }, 1024, thresholds), 'slow');
  assert.equal(classifyAnalyzeLane({ durationSec: 30 }, 33 * 1024 * 1024, thresholds), 'slow');
  assert.equal(classifyAnalyzeLane({ duration: 601000 }, 1024, thresholds), 'slow');
});

test('analysis lane thresholds remain overridable', () => {
  const thresholds = resolveAnalyzeLaneThresholds({
    HOTVIDEO_SLOW_VIDEO_DURATION_SEC: '300',
    HOTVIDEO_SLOW_VIDEO_BYTES: '2048',
  });

  assert.deepEqual(thresholds, { durationSec: 300, videoBytes: 2048 });
});

test('buildInvalidVideoMeta turns missing video records into terminal filtered records', () => {
  const meta = buildInvalidVideoMeta({
    id: '7631602331755619187',
    title: '历史缺失视频',
    status: 'new',
    analysis: null,
  }, 'F:/coding/solo-company/hotvideo/videos/douyin-hotspot/7631602331755619187/video.mp4', '2026-06-27T00:00:00.000Z');

  assert.equal(meta.status, 'filtered');
  assert.equal(meta.has_video, false);
  assert.equal(meta.analysis.relevant, false);
  assert.match(meta.analysis.filter_reason, /缺失或无效/);
  assert.equal(meta.analysis.read_evidence, '未读取视频：本地 video.mp4 缺失或小于 1KB。');
  assert.equal(meta.filteredAt, '2026-06-27T00:00:00.000Z');
});
