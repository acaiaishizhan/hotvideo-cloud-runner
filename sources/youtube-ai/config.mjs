import fs from 'node:fs';
import path from 'node:path';

const HOTVIDEO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(HOTVIDEO_ROOT, '..');
const bundledVideoInfra = path.join(HOTVIDEO_ROOT, 'video-infra');

export const seedChannels = Object.freeze([
  { id: 'UCXZCJLdBC09xxGZ6gcdrc6A', uploads: 'UUXZCJLdBC09xxGZ6gcdrc6A', title: 'OpenAI', focused: true },
  { id: 'UCP7jMXSY2xbc3KCAE0MHQ-A', uploads: 'UUP7jMXSY2xbc3KCAE0MHQ-A', title: 'Google DeepMind', focused: true },
  { id: 'UCcIXc5mJsHVYTZR1maL5l9w', uploads: 'UUcIXc5mJsHVYTZR1maL5l9w', title: 'DeepLearningAI', focused: true },
  { id: 'UCbfYPyITQ-7l4upoX8nvctg', uploads: 'UUbfYPyITQ-7l4upoX8nvctg', title: 'Two Minute Papers', focused: true },
  { id: 'UCawZsQWqfGSbCI5yjkdVkTA', uploads: 'UUawZsQWqfGSbCI5yjkdVkTA', title: 'Matthew Berman', focused: true },
  { id: 'UCbY9xX3_jW5c2fjlZVBI4cg', uploads: 'UUbY9xX3_jW5c2fjlZVBI4cg', title: 'TheAIGRID', focused: true },
  { id: 'UC2WmuBuFq6gL08QYG-JjXKw', uploads: 'UU2WmuBuFq6gL08QYG-JjXKw', title: 'WorldofAI', focused: true },
  { id: 'UChpleBmo18P08aKCIgti38g', uploads: 'UUhpleBmo18P08aKCIgti38g', title: 'Matt Wolfe', focused: true },
  { id: 'UCNJ1Ymd5yFuUPtn21xtRbbw', uploads: 'UUNJ1Ymd5yFuUPtn21xtRbbw', title: 'AI Explained', focused: true },
  { id: 'UC5l7RouTQ60oUjLjt1Nh-UQ', uploads: 'UU5l7RouTQ60oUjLjt1Nh-UQ', title: 'AI Revolution', focused: true },
  { id: 'UCHlNU7kIZhRgSbhHvFoy72w', uploads: 'UUHlNU7kIZhRgSbhHvFoy72w', title: 'Hugging Face', focused: true },
  { id: 'UCHuiy8bXnmK5nisYHUd1J5g', uploads: 'UUHuiy8bXnmK5nisYHUd1J5g', title: 'NVIDIA', focused: false },
  { id: 'UCKWaEZ-_VweaEx1j62do_vQ', uploads: 'UUKWaEZ-_VweaEx1j62do_vQ', title: 'IBM Technology', focused: false },
  { id: 'UCJS9pqu9BzkAMNTmzNMNhvg', uploads: 'UUJS9pqu9BzkAMNTmzNMNhvg', title: 'Google Cloud Tech', focused: false },
  { id: 'UCsMica-v34Irf9KVTh6xx-g', uploads: 'UUsMica-v34Irf9KVTh6xx-g', title: 'Microsoft Developer', focused: false },
  { id: 'UCcefcZRL2oaA_uBNeo5UOWg', uploads: 'UUcefcZRL2oaA_uBNeo5UOWg', title: 'Y Combinator', focused: false },
  { id: 'UCsBjURrPoezykLs9EqgamOA', uploads: 'UUsBjURrPoezykLs9EqgamOA', title: 'Fireship', focused: false },
  { id: 'UCCjyq_K1Xwfg8Lndy7lKMpA', uploads: 'UUCjyq_K1Xwfg8Lndy7lKMpA', title: 'TechCrunch', focused: false },
]);

export default {
  videosDir: path.join(HOTVIDEO_ROOT, 'videos', 'youtube-ai'),
  videoInfraCmd: 'python',
  videoInfraArgs: ['-m', 'video_infra'],
  videoInfraCwd: fs.existsSync(bundledVideoInfra)
    ? bundledVideoInfra
    : path.join(WORKSPACE_ROOT, 'video-infra'),
  videoInfraTimeoutMs: 600000,
  videoInfraFormatId: 'bestvideo[height<=480]+bestaudio/best[height<=480]',
  feishuAttachmentField: null,
  sourceType: '科技/科技科普',
  regionCodes: ['US'],
  popularCategoryIds: ['28', '25', '22', '24', '26'],
  searchQueries: [
    'AI|artificial intelligence|generative AI|machine learning',
    'OpenAI|Anthropic|Claude|ChatGPT|Gemini|DeepSeek|Grok',
    'AI agent|AI coding|vibe coding|large language model|LLM',
    'AI robotics|AI chip|NVIDIA AI|AI safety|AGI',
  ],
  seedChannels,
  dateWindowHours: 12,
  discoveryWindowHours: 14,
  popularWindowHours: 14,
  channelItemsPerRun: 12,
  maxClassify: 40,
  maxPending: 30,
  minViewCount: 1000,
  classifierBatchSize: 8,
  classifierTimeoutMs: 60000,
};
