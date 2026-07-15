// ============================================================
//  完整视频口播文案 provider 选择层
// ============================================================

import { transcribeVideoCopy } from './transcribe-video-copy.mjs';
import { transcribeVideoCopyWithDoubao } from './doubao-video-copy.mjs';

export function resolveVideoCopyProvider(env = process.env) {
  const provider = (env.HOTVIDEO_TRANSCRIBE_PROVIDER || 'doubao').trim().toLowerCase();
  if (provider === 'whisper' || provider === 'faster-whisper') return 'whisper';
  if (provider === 'doubao') return 'doubao';
  throw new Error(`不支持的 HOTVIDEO_TRANSCRIBE_PROVIDER: ${provider}`);
}

export function resolveVideoCopyFallback(env = process.env) {
  const fallback = (env.HOTVIDEO_TRANSCRIBE_FALLBACK || 'whisper').trim().toLowerCase();
  if (!fallback || fallback === 'none' || fallback === 'off') return '';
  if (fallback === 'whisper' || fallback === 'faster-whisper') return 'whisper';
  throw new Error(`不支持的 HOTVIDEO_TRANSCRIBE_FALLBACK: ${fallback}`);
}

export function resolveVideoCopyConcurrency(env = process.env) {
  const raw = Number.parseInt(env.HOTVIDEO_TRANSCRIBE_CONCURRENCY || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return resolveVideoCopyProvider(env) === 'doubao' ? 3 : 1;
}

export async function transcribeVideoCopyAuto(videoDir, meta = {}, opts = {}) {
  const provider = opts.provider || resolveVideoCopyProvider();
  try {
    if (provider === 'doubao') {
      return await transcribeVideoCopyWithDoubao(videoDir, meta, opts.doubao || {});
    }
    return transcribeVideoCopy(videoDir, meta, opts.whisper || {});
  } catch (err) {
    const fallback = opts.fallback ?? resolveVideoCopyFallback();
    if (provider !== 'whisper' && fallback === 'whisper') {
      return transcribeVideoCopy(videoDir, meta, opts.whisper || {});
    }
    throw err;
  }
}

export function transcriptMetaFromResult(transcript) {
  const runtime = transcript?.result?.runtime || {};
  return {
    jsonPath: transcript?.jsonPath,
    textPath: transcript?.textPath,
    provider: runtime.provider,
    model: runtime.model,
    device: runtime.device,
    computeType: runtime.compute_type || runtime.computeType,
    audioAccess: transcript?.result?.audio_access,
    confidence: transcript?.result?.confidence,
  };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number.parseInt(String(concurrency || 1), 10) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}
