import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVideoInfraInvocation } from './video-infra-command.mjs';

test('buildVideoInfraInvocation keeps URLs and output paths as separate arguments', () => {
  const invocation = buildVideoInfraInvocation({
    videoInfraCmd: 'python',
    videoInfraArgs: ['-m', 'video_infra'],
  }, 'download', [
    'https://example.com/video?a=1&b="quoted"',
    '--output-dir',
    'F:\\temp folder\\video',
  ]);

  assert.equal(invocation.command, 'python');
  assert.deepEqual(invocation.args, [
    '-m', 'video_infra', 'download',
    'https://example.com/video?a=1&b="quoted"',
    '--output-dir', 'F:\\temp folder\\video',
  ]);
});
