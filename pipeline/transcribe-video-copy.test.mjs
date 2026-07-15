import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fullVideoCopyFromTranscript,
  resolveTranscribeOptions,
  transcriptPaths,
} from './transcribe-video-copy.mjs';

test('resolveTranscribeOptions defaults to GPU-first large-v3 auto mode', () => {
  const options = resolveTranscribeOptions({});

  assert.equal(options.python, 'python');
  assert.equal(options.model, 'large-v3');
  assert.equal(options.device, 'auto');
  assert.equal(options.computeType, 'auto');
});

test('fullVideoCopyFromTranscript prefers full_text and falls back to segments', () => {
  assert.equal(
    fullVideoCopyFromTranscript({ full_text: '  完整文案  ', segments: [{ text: '忽略' }] }),
    '完整文案'
  );
  assert.equal(
    fullVideoCopyFromTranscript({ segments: [{ text: '第一句' }, { text: ' 第二句 ' }, { text: '' }] }),
    '第一句\n第二句'
  );
});

test('transcriptPaths stores transcript artifacts beside each video', () => {
  const paths = transcriptPaths('F:/work/video-item');

  assert.equal(paths.jsonPath, 'F:\\work\\video-item\\transcript.json');
  assert.equal(paths.textPath, 'F:\\work\\video-item\\transcript.txt');
});
