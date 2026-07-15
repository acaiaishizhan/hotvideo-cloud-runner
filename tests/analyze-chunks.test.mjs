import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeChunkDoubaoOutputs } from '../pipeline/analyze.mjs';

test('分段结果合并口播、主题和相关性', () => {
  const output = mergeChunkDoubaoOutputs([
    {
      result: {
        has_spoken_audio: true,
        relevant: false,
        filter_reason: '铺垫',
        summary: '第一段',
        content_type: '其他',
        topics: ['其他'],
        tags: ['开场'],
        read_evidence: '看到开场',
        full_video_copy: '第一段口播',
      },
      runtime: { model: 'doubao', baseUrl: 'ark' },
    },
    {
      result: {
        has_spoken_audio: true,
        relevant: true,
        filter_reason: '',
        summary: '核心知识',
        content_type: '知识科普',
        topics: ['AI'],
        tags: ['教程'],
        hook: '钩子',
        viral_reason: '原因',
        imitation_angle: '角度',
        read_evidence: '看到演示',
        full_video_copy: '第二段口播',
      },
      runtime: { model: 'doubao', baseUrl: 'ark' },
    },
  ]);
  assert.equal(output.result.relevant, true);
  assert.equal(output.result.summary, '核心知识');
  assert.equal(output.result.full_video_copy, '第一段口播\n第二段口播');
  assert.equal(output.runtime.chunkCount, 2);
});
