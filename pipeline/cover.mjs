import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildVideoInfraInvocation } from './video-infra-command.mjs';

export function ensureCoverFile(meta, config, videoDir, run = execFileSync) {
  const saved = meta.files?.thumbnailPath;
  if (saved && fs.existsSync(saved) && fs.statSync(saved).size >= 100) return saved;
  const url = meta.scraped?.thumbnailUrl || meta.thumbnailUrl;
  if (!url) throw new Error('视频没有原封面地址');
  const invocation = buildVideoInfraInvocation(config, 'thumbnail', [url, '--output-dir', path.resolve(videoDir)]);
  const result = JSON.parse(run(invocation.command, invocation.args, {
    encoding: 'utf8', timeout: 60000, cwd: config.videoInfraCwd,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  }));
  const file = result.files?.thumbnailPath;
  if (!result.ok || !file || !fs.existsSync(file) || fs.statSync(file).size < 100) {
    throw new Error(result.error || '封面下载未产出有效文件');
  }
  meta.files ||= {};
  meta.files.thumbnailPath = file;
  meta.thumbnailUrl = url;
  return file;
}

export function uploadRequestedCover(meta, {
  config, videoDir, recordId, readAttachment, uploadAttachment, accepted, download = ensureCoverFile,
}) {
  if (!config.feishuCoverField || !meta.cover_requested) return false;
  try {
    const state = readAttachment(recordId, config.feishuCoverField);
    if (state?.attachmentKnown !== true) throw new Error('封面附件状态未知');
    if (!state.hasAttachment) {
      const file = download(meta, config, videoDir);
      const response = uploadAttachment(recordId, config.feishuCoverField, file);
      if (!accepted(response)) throw new Error('飞书未确认封面附件上传');
    }
    meta.cover_uploaded = true;
    delete meta.cover_error;
    return true;
  } catch (error) {
    meta.cover_uploaded = false;
    meta.cover_error = error.message;
    throw error;
  }
}
