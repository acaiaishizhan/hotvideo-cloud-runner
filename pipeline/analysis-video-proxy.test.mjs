import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnalysisProxyArgs,
  resolveAnalysisProxyOptions,
} from './analysis-video-proxy.mjs';

test('analysis proxy targets a bounded low-fps 240p MP4', () => {
  const options = resolveAnalysisProxyOptions({}, 9300);

  assert.equal(options.targetBytes, 64 * 1024 * 1024);
  assert.equal(options.audioKbps, 24);
  assert.equal(options.videoKbps, 33);

  const args = buildAnalysisProxyArgs('input.mp4', 'output.mp4', options);
  assert.deepEqual(args.slice(0, 3), ['-hide_banner', '-loglevel', 'error']);
  assert.ok(args.includes('scale=-2:240:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=1'));
  assert.ok(args.includes('33k'));
  assert.ok(args.includes('24k'));
  assert.equal(args.at(-1), 'output.mp4');
});

test('analysis proxy bitrate grows for shorter videos but stays capped', () => {
  const options = resolveAnalysisProxyOptions({
    HOTVIDEO_ANALYZE_PROXY_TARGET_BYTES: String(64 * 1024 * 1024),
    HOTVIDEO_ANALYZE_PROXY_MAX_VIDEO_KBPS: '200',
  }, 600);

  assert.equal(options.videoKbps, 200);
});
