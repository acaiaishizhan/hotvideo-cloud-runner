// ============================================================
//  agy-wsl 视频分析 - 提示词配置
//  修改此文件即可调整分析输出，无需改动 analyze.mjs
// ============================================================

// ── 内容类型（单选，agy 只能从中选一个） ─────────────────
export const CONTENT_TYPES = [
  '工具教程',
  '效果展示',
  '产品测评',
  '行业资讯',
  '深度解读',
  '案例拆解',
  '观点输出',
  '科普讲解',
  '盘点合集',
  '其他',
];

// ── 主题（多选，agy 可选 1~3 个） ────────────────────────
export const TOPICS = [
  'AI绘画/图片',
  'AI视频',
  'AI编程',
  'AI写作',
  'AI Agent',
  '大模型动态',
  'AI硬件/芯片',
  'AI商业/创业',
  'AI行业影响',
  '提示词技巧',
  '开源工具',
  '国学传统文化',
  '人生智慧',
  '健康养生',
  '社会观察',
  '家庭关系',
  '历史人文',
  '其他',
];

// ── 过滤规则（不符合的视频会被标记为 filtered） ──────────────
// agy 会根据这些规则判断视频是否值得收录
export const FILTER_RULES = `以下类型的视频应该被过滤掉（relevant=false）：
- 纯 AI 生成的艺术作品/短片/MV，没有讲解、教学或实用信息（比如纯 AI 动画、AI 音乐 MV）
- 没有人声讲解，也没有文字说明的纯展示类内容
- 与 AI 技术、科技科普无关的内容（即使标题带了 AI 标签）
- 娱乐搞笑为主，不涉及 AI 知识或应用的内容

以下类型的视频应该保留（relevant=true）：
- AI 工具教程、使用技巧、提示词分享
- AI 行业新闻、产品发布、公司动态
- AI 技术科普、原理讲解
- AI 应用案例分析、商业解读
- AI 对行业/职业的影响分析
- 有实操演示的 AI 效果展示（带讲解或教学价值）`;

export const HUMANITIES_GUOXUE_FILTER_RULES = `以下类型的视频应该被过滤掉（relevant=false）：
- 纯玄学算命、许愿祈福、功德诱导，缺少知识解释
- 纯情绪鸡汤，没有具体观点、故事或可复用表达
- 纯带货、课程收徒、直播引流
- 宗教宣传色彩过重，但没有文化、历史或知识解释
- 娱乐搞笑为主，不涉及国学、传统文化、修身处世或人生经验

以下类型的视频应该保留（relevant=true）：
- 国学经典、传统文化、历史典故、修身处世的讲解
- 面向中老年人的人生经验、家庭伦理、心态调节
- 有清晰观点、故事案例或可复用表达的视频
- 能沉淀成选题的人生智慧、传统文化、社会经验内容`;

export const HUMANITIES_SHEKE_FILTER_RULES = `以下类型的视频应该被过滤掉（relevant=false）：
- 泛泛骂社会、阴谋论、极端情绪动员
- 政治风险高、事实依据弱或明显煽动对立的内容
- 纯段子、纯冲突、纯娱乐，没有分析价值
- 纯带货、课程收徒、直播引流

以下类型的视频应该保留（relevant=true）：
- 社会观察、代际关系、养老、家庭、退休、婚姻关系
- 哲学、社会学、历史视角解释现实问题
- 有清晰论点，适合拆成选题的视频
- 面向中老年人的生活处境、观念变化和现实困惑分析`;

// ── 系统提示词 ──────────────────────────────────────────────
export const SYSTEM_PROMPT = `你是一个短视频内容分析助手，专注于 AI 和科技科普领域。
你的任务是：
1. 先判断视频是否值得收录（是否与 AI 讲解/实战/科普/热点相关）
2. 如果值得收录，输出结构化的分析结果

${FILTER_RULES}

输出要求：
- 所有输出使用中文
- 严格按照 JSON 格式输出，不要输出任何其他内容
- 不要在字段值前面加"开头钩子："、"爆点原因："等前缀标签，直接写内容
- 一句话总结要简洁有力，不超过 30 字`;

function systemPrompt({ focus, task, filterRules }) {
  return `你是一个短视频内容分析助手，专注于${focus}。
你的任务是：
1. 先判断视频是否值得收录（${task}）
2. 如果值得收录，输出结构化的分析结果

${filterRules}

输出要求：
- 所有输出使用中文
- 严格按照 JSON 格式输出，不要输出任何其他内容
- 不要在字段值前面加"开头钩子："、"爆点原因："等前缀标签，直接写内容
- 一句话总结要简洁有力，不超过 30 字`;
}

export function buildSystemPromptForMeta(meta = {}) {
  const sourceType = String(meta.scraped?.sourceType || meta.sourceType || '');
  if (sourceType === '人文社科/国学') {
    return systemPrompt({
      focus: '国学、传统文化、修身处世和中老年人生经验内容',
      task: '是否有国学/传统文化/人生智慧/中老年生活启发价值',
      filterRules: HUMANITIES_GUOXUE_FILTER_RULES,
    });
  }
  if (sourceType === '人文社科/社科') {
    return systemPrompt({
      focus: '社会观察、哲学思考、家庭关系和中老年现实议题',
      task: '是否有社会观察/哲学思考/家庭关系/中老年现实议题价值',
      filterRules: HUMANITIES_SHEKE_FILTER_RULES,
    });
  }
  return SYSTEM_PROMPT;
}

// ── 用户提示词模板 ──────────────────────────────────────────
// 可用占位符：{title}, {author}, {play_count}, {like_count},
//             {duration_text}, {billboard_names}
export const USER_PROMPT_TEMPLATE = `分析这个短视频。以下是视频的元数据：
- 标题：{title}
- 作者：{author}
- 播放量：{play_count}
- 点赞数：{like_count}
- 时长：{duration_text}
- 上榜：{billboard_names}
- 完整口播转写：{full_video_copy}

请严格按以下 JSON 格式输出（不要输出 markdown 代码块，直接输出纯 JSON）：
{
  "relevant": true或false,
  "filter_reason": "如果 relevant=false，说明过滤原因；如果 relevant=true，填空字符串",
  "summary": "一句话总结视频核心内容，不超过30字",
  "content_type": "从以下选项中选一个：${CONTENT_TYPES.join('、')}",
  "topics": ["从以下选项中选1~3个：${TOPICS.join('、')}"],
  "tags": ["3~5个关键词标签，自由填写"],
  "hook": "视频前3秒用什么方式吸引观众（直接描述，不要加前缀）",
  "viral_reason": "分析这个视频为什么能上热榜（直接描述，不要加前缀）",
  "imitation_angle": "给出1~2个具体的模仿方向（直接描述，不要加前缀）",
  "full_video_copy": "完整口播转写原文；优先原样返回上面的完整口播转写，没有则空字符串"
}

注意：
- 如果 relevant=false，后面的 summary/content_type/topics 等字段仍然要填写，但可以简略
- full_video_copy 不要改写、总结或润色；本地转写为空时填空字符串
- 每个字段的值直接写内容，不要重复字段名作为前缀`;
