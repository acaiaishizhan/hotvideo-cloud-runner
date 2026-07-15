import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnalysisChunkArgs,
  buildAnalysisProxyArgs,
  resolveAnalysisProxyOptions,
} from '../pipeline/analysis-video-proxy.mjs';

test('长视频分析副本把奇数宽高填充为偶数', () => {
  const options = resolveAnalysisProxyOptions({}, 436);
  const args = buildAnalysisProxyArgs('input.mp4', 'output.mp4', options);
  assert.ok(args.includes(
    'scale=-2:360:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=4',
  ));
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('240'));
  assert.equal(options.targetBytes, 20 * 1024 * 1024);
});

test('分析分段保留音视频并重置时间戳', () => {
  const args = buildAnalysisChunkArgs('input.mp4', 'chunk-%03d.mp4', 180);
  assert.deepEqual(args.slice(-6), ['-f', 'segment', '-segment_time', '180', '-reset_timestamps', '1', 'chunk-%03d.mp4'].slice(-6));
  assert.ok(args.includes('copy'));
});
