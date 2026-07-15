import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapWithConcurrency,
  resolveVideoCopyConcurrency,
  resolveVideoCopyFallback,
  resolveVideoCopyProvider,
  transcriptMetaFromResult,
} from './video-copy-provider.mjs';

test('resolveVideoCopyProvider defaults to doubao and supports whisper fallback', () => {
  assert.equal(resolveVideoCopyProvider({}), 'doubao');
  assert.equal(resolveVideoCopyProvider({ HOTVIDEO_TRANSCRIBE_PROVIDER: 'whisper' }), 'whisper');
  assert.equal(resolveVideoCopyFallback({}), 'whisper');
  assert.equal(resolveVideoCopyFallback({ HOTVIDEO_TRANSCRIBE_FALLBACK: 'none' }), '');
});

test('resolveVideoCopyConcurrency defaults to remote-friendly parallelism', () => {
  assert.equal(resolveVideoCopyConcurrency({}), 3);
  assert.equal(resolveVideoCopyConcurrency({ HOTVIDEO_TRANSCRIBE_PROVIDER: 'whisper' }), 1);
  assert.equal(resolveVideoCopyConcurrency({ HOTVIDEO_TRANSCRIBE_CONCURRENCY: '5' }), 5);
});

test('transcriptMetaFromResult maps Doubao runtime metadata', () => {
  const meta = transcriptMetaFromResult({
    jsonPath: 'transcript.json',
    textPath: 'transcript.txt',
    result: {
      audio_access: true,
      confidence: 'high',
      runtime: {
        provider: 'doubao',
        model: 'doubao-seed-2.0-pro',
      },
    },
  });

  assert.equal(meta.provider, 'doubao');
  assert.equal(meta.model, 'doubao-seed-2.0-pro');
  assert.equal(meta.audioAccess, true);
  assert.equal(meta.confidence, 'high');
});

test('mapWithConcurrency preserves order', async () => {
  const result = await mapWithConcurrency([1, 2, 3], 2, async item => item * 2);

  assert.deepEqual(result, [2, 4, 6]);
});
