import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {
  agyRetryDelayMsForResult,
  isAgyAuthFailureResult,
  isRetryableAgyAnalyzeResult,
  PIPELINE_STAGES,
  shouldEscalateStageFailures,
  summarizeStageFailures,
} from './orchestrator.mjs';

const HOTVIDEO_ROOT = path.resolve(import.meta.dirname, '..');

test('normal orchestrator contains no full-table interaction refresh stage', () => {
  assert.deepEqual(PIPELINE_STAGES, ['scrape', 'fetch', 'analyze', 'publish']);
});

test('orchestrator exits non-zero when a requested source fails', () => {
  const result = spawnSync(process.execPath, [
    'pipeline/orchestrator.mjs',
    '--source',
    'missing-source-for-test',
  ], {
    cwd: HOTVIDEO_ROOT,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-source-for-test/);
});

test('orchestrator accepts a runtime date window override', () => {
  const result = spawnSync(process.execPath, [
    'pipeline/orchestrator.mjs',
    '--source',
    'douyin-hotspot',
    '--date-window',
    '24',
    '--skip-scrape',
    '--skip-fetch',
    '--skip-analyze',
    '--skip-publish',
    '--skip-refresh',
  ], {
    cwd: HOTVIDEO_ROOT,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dateWindow=24/);
});

test('orchestrator accepts runtime category profile and limit overrides', () => {
  const result = spawnSync(process.execPath, [
    'pipeline/orchestrator.mjs',
    '--source',
    'douyin-hotspot',
    '--category-profile',
    'renwen-guoxue',
    '--analyzer',
    'doubao',
    '--analyze-concurrency',
    '5',
    '--analyze-lane',
    'slow',
    '--analyze-limit',
    '3',
    '--limit',
    '8',
    '--skip-scrape',
    '--skip-fetch',
    '--skip-analyze',
    '--skip-publish',
    '--skip-refresh',
  ], {
    cwd: HOTVIDEO_ROOT,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /categoryProfile=renwen-guoxue/);
  assert.match(result.stdout, /analyzer=doubao/);
  assert.match(result.stdout, /analyzeConcurrency=5/);
  assert.match(result.stdout, /analyzeLane=slow/);
  assert.match(result.stdout, /analyzeLimit=3/);
  assert.match(result.stdout, /limit=8/);
});

test('summarizeStageFailures reports non-fatal stage failure counts', () => {
  const failures = summarizeStageFailures([
    { stage: 'fetch', result: { downloaded: 3, failed: 2 } },
    { stage: 'analyze', result: { analyzed: 1, failed: 1 } },
    { stage: 'publish', result: { published: 1, failed: 0 } },
  ]);

  assert.deepEqual(failures, [
    { stage: 'fetch', failed: 2 },
    { stage: 'analyze', failed: 1 },
  ]);
});

test('run-result envelope mode keeps item failures out of the stage-level exit path', () => {
  const failures = [{ stage: 'analyze', failed: 2 }];
  assert.equal(shouldEscalateStageFailures(failures, {}), true);
  assert.equal(shouldEscalateStageFailures(failures, { HOTVIDEO_RESULT_ENVELOPE_MODE: '1' }), false);
  assert.equal(shouldEscalateStageFailures([], {}), false);
});

test('isRetryableAgyAnalyzeResult only accepts agy transient failures', () => {
  assert.equal(isRetryableAgyAnalyzeResult({
    failed: 2,
    failureReasons: [
      "ENOENT: no such file or directory, open 'F:\\coding\\solo-company\\temp\\hotvideo-agy\\run-a0ej1M\\analysis.json'",
      '无法解析 JSON: Error: timeout waiting for response',
    ],
  }), true);

  assert.equal(isRetryableAgyAnalyzeResult({
    failed: 1,
    failureReasons: ['本地 video.mp4 缺失或无效'],
  }), false);

  assert.equal(isRetryableAgyAnalyzeResult({ failed: 0, failureReasons: [] }), false);
});

test('agy auth failures use a longer retry delay than ordinary transient failures', () => {
  const authFailure = {
    failed: 1,
    failureReasons: [
      '无法解析 JSON: Error: authentication failed or timed out | agy log: keyringAuth timed out after 5s',
    ],
  };
  const ordinaryFailure = {
    failed: 1,
    failureReasons: [
      '无法解析 JSON: Error: timeout waiting for response',
    ],
  };

  assert.equal(isAgyAuthFailureResult(authFailure), true);
  assert.equal(agyRetryDelayMsForResult(authFailure, {}), 60000);
  assert.equal(agyRetryDelayMsForResult(ordinaryFailure, {}), 30000);
  assert.equal(agyRetryDelayMsForResult(authFailure, { HOTVIDEO_AGY_AUTH_RETRY_DELAY_MS: '90000' }), 90000);
});
