import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export default {
  videosDir: path.join(ROOT, 'videos', 'douyin-hotspot'),
  videoInfraCmd: process.env.PYTHON || 'python',
  videoInfraArgs: ['-m', 'video_infra'],
  videoInfraCwd: path.join(ROOT, 'video-infra'),
  videoInfraTimeoutMs: 180000,
  // Hotvideo 只回传结构化数据，不再上传视频附件。
  feishuAttachmentField: null,
  categoryProfiles: {
    'tech-kepu': { label: '科技/科技科普' },
    'renwen-guoxue': { label: '人文社科/国学' },
    'renwen-sheke': { label: '人文社科/社科' },
  },
};
