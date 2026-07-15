import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalysisProxyArgs, resolveAnalysisProxyOptions } from '../pipeline/analysis-video-proxy.mjs';

test('长视频分析副本把奇数宽高填充为偶数', () => {
  const options = resolveAnalysisProxyOptions({}, 436);
  const args = buildAnalysisProxyArgs('input.mp4', 'output.mp4', options);
  assert.ok(args.includes(
    'scale=-2:360:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=4',
  ));
  assert.ok(args.includes('yuv420p'));
  assert.equal(options.targetBytes, 20 * 1024 * 1024);
});
