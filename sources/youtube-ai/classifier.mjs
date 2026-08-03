import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const DEFAULT_MODEL = 'doubao-seed-2.1-turbo';

function readEnvValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(WORKSPACE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find(item => item.trimStart().startsWith(`${name}=`));
  return line?.split('=', 2)[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
}

function extractJson(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`AI 分类输出不是 JSON: ${cleaned.slice(0, 300)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function normalizeClassification(value = {}) {
  const allowed = new Set(['ai_topic', 'ai_generated', 'not_ai', 'uncertain']);
  const relation = allowed.has(value.relation) ? value.relation : 'uncertain';
  const confidence = Math.max(0, Math.min(1, Number(value.confidence) || 0));
  return {
    relation,
    confidence,
    reason: String(value.reason || '').slice(0, 240),
    ...(value.failed ? { failed: true } : {}),
  };
}

export function shouldKeepCandidate(candidate) {
  const result = normalizeClassification(candidate?.classification);
  if (result.relation === 'ai_topic') return true;
  return result.relation === 'uncertain'
    && Boolean(candidate?.keepOnClassifierFailure || candidate?.lanes?.includes('channel:focused'));
}

export function buildClassifierPrompt(candidates) {
  const compact = candidates.map(item => ({
    id: item.id,
    title: item.title,
    channel: item.channelTitle,
    description: String(item.description || '').slice(0, 600),
    tags: (item.tags || []).slice(0, 15),
    lanes: item.lanes || [],
  }));
  return [
    '判断每条 YouTube 视频与人工智能的关系。只返回 JSON 对象。',
    'relation 只能是：',
    '- ai_topic：内容在讨论或教授 AI，包括模型、产品、Agent、机器学习研究、AI 编程、AI 芯片、机器人智能、政策安全、商业和行业影响。',
    '- ai_generated：主要只是 AI 生成的娱乐、动画、音乐、ASMR 或猎奇内容，没有 AI 知识、新闻、教程或观点价值。',
    '- not_ai：与 AI 无关。',
    '- uncertain：现有文字确实不足以判断。不要因为标题含 AI 两个字就判定为 ai_topic。',
    '宁可把真正不确定的内容留给视频复审，也不要把可能的 AI 议题轻易判成 not_ai。',
    '输出格式：{"items":[{"id":"...","relation":"ai_topic|ai_generated|not_ai|uncertain","confidence":0到1,"reason":"一句中文理由"}]}',
    `待判断视频：${JSON.stringify(compact)}`,
  ].join('\n');
}

export async function classifyCandidates(candidates, {
  apiKey = readEnvValue('ARK_API_KEY'),
  baseUrl = process.env.HOTVIDEO_YOUTUBE_CLASSIFIER_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.HOTVIDEO_YOUTUBE_CLASSIFIER_MODEL || DEFAULT_MODEL,
  batchSize = 4,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45000,
  retries = 1,
  retryDelayMs = 2000,
  allowSingleFallback = true,
  failOpen = false,
} = {}) {
  if (!apiKey) throw new Error('缺少 ARK_API_KEY，无法进行 YouTube AI 文本分类');
  const results = new Map();
  const batchCount = Math.ceil(candidates.length / batchSize);
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const batchNumber = Math.floor(start / batchSize) + 1;
    console.log(`[youtube-ai] 文本分类批次 ${batchNumber}/${batchCount}，${batch.length} 条`);
    let parsed;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: '你是高召回的 AI 主题视频分类器。必须输出合法 JSON，不要解释，不要 markdown。' },
              { role: 'user', content: buildClassifierPrompt(batch) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 1500,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`AI 文本分类 HTTP ${response.status}: ${text.slice(0, 500)}`);
        const payload = JSON.parse(text);
        parsed = extractJson(payload?.choices?.[0]?.message?.content || '');
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        console.warn(`[youtube-ai] 分类批次 ${batchNumber} 失败，重试 ${attempt + 2}/${retries + 1}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    if (!parsed) {
      if (failOpen) {
        for (const candidate of batch) {
          results.set(candidate.id, {
            relation: 'uncertain',
            confidence: 0,
            reason: `文本分类超时，按候选自身信号决定是否进入视频复审: ${lastError?.message || '未知错误'}`.slice(0, 240),
            failed: true,
          });
        }
        continue;
      }
      if (!allowSingleFallback || batch.length === 1) {
        throw new Error(`AI 文本分类批次 ${batchNumber}/${batchCount} 失败: ${lastError?.message || '未知错误'}`);
      }
      console.warn(`[youtube-ai] 分类批次 ${batchNumber} 连续失败，降级为逐条判断`);
      for (const candidate of batch) {
        try {
          const [single] = await classifyCandidates([candidate], {
            apiKey,
            baseUrl,
            model,
            batchSize: 1,
            fetchImpl,
            timeoutMs,
            retries: 0,
            retryDelayMs,
            allowSingleFallback: false,
          });
          results.set(candidate.id, single.classification);
        } catch (error) {
          results.set(candidate.id, {
            relation: 'uncertain',
            confidence: 0,
            reason: `文本分类连续失败，保留给视频复审: ${error.message}`.slice(0, 240),
            failed: true,
          });
        }
      }
      continue;
    }
    for (const item of parsed.items || []) {
      if (batch.some(candidate => candidate.id === item.id)) {
        results.set(item.id, normalizeClassification(item));
      }
    }
  }
  return candidates.map(candidate => ({
    ...candidate,
    classification: results.get(candidate.id) || {
      relation: 'uncertain', confidence: 0, reason: '分类器未返回该视频，交给视频复审', failed: true,
    },
  }));
}
