import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRunResultEnvelope,
  collectRunResultItems,
  runPipelinePhases,
  shouldFailRunResultEnvelope,
  validateRunResultEnvelope,
} from './run-queue.mjs';

function manifest() {
  return {
    source: 'douyin-hotspot',
    scrapedAt: '2026-07-17T00:00:00.000Z',
    items: [
      { id: '7662298104951033094', url: 'https://www.douyin.com/video/7662298104951033094' },
      { id: '7662298104951033095', url: 'https://www.douyin.com/video/7662298104951033095' },
    ],
    repeatUpdates: {
      items: [{ id: '7662298104951033096', url: 'https://www.douyin.com/video/7662298104951033096' }],
    },
  };
}

test('run-result 信封同时记录成功和失败，成功项不携带 payload', (t) => {
  const videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-result-'));
  t.after(() => fs.rmSync(videosDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(videosDir, '7662298104951033094'));
  fs.writeFileSync(path.join(videosDir, '7662298104951033094', 'meta.json'), JSON.stringify({ status: 'published' }));
  fs.mkdirSync(path.join(videosDir, '7662298104951033095'));
  fs.writeFileSync(path.join(videosDir, '7662298104951033095', 'meta.json'), JSON.stringify({ status: 'new', analysis_error: 'timeout' }));
  fs.writeFileSync(path.join(videosDir, 'repeat-updates.json'), JSON.stringify({ items: manifest().repeatUpdates.items }));

  const items = collectRunResultItems(manifest(), videosDir);
  assert.deepEqual(items.map(item => [item.recoveryKey, item.status]), [
    ['7662298104951033094:new-video', 'success'],
    ['7662298104951033095:new-video', 'failure'],
    ['7662298104951033096:interaction-update', 'failure'],
  ]);
  assert.equal('recoveryPayload' in items[0], false);
  assert.equal(items[1].recoverAttempt, 0);
});

test('run-result schema 拒绝缺恢复证据的失败项', () => {
  const envelope = buildRunResultEnvelope({
    manifest: { ...manifest(), items: [], repeatUpdates: { items: [] } },
    queueFile: 'queue/a.json',
    videosDir: os.tmpdir(),
    env: { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'abc' },
    startedAt: '2026-07-17T00:00:00.000Z',
    finishedAt: '2026-07-17T00:01:00.000Z',
  });
  validateRunResultEnvelope(envelope);
  envelope.items = [{ recoveryKey: 'x:new-video', status: 'failure', recoverAttempt: 0 }];
  assert.throws(() => validateRunResultEnvelope(envelope), /恢复证据不完整/);
});

test('fast 失败也继续执行 slow phase', async () => {
  const calls = [];
  const result = await runPipelinePhases(manifest(), { categoryProfile: '', dateWindow: '' }, async args => {
    calls.push(args);
    return { code: calls.length === 1 ? 1 : 0 };
  });
  assert.equal(calls.length, 2);
  assert.equal(result.fast.code, 1);
  assert.equal(result.slow.code, 0);
});

test('0 成功即使信封已持久化也按阶段级故障退出', () => {
  assert.equal(shouldFailRunResultEnvelope({ items: [{ status: 'failure' }] }), true);
  assert.equal(shouldFailRunResultEnvelope({ items: [{ status: 'failure' }, { status: 'success' }] }), false);
  assert.equal(shouldFailRunResultEnvelope({ items: [] }), false);
});

test('published 但附件明确失败仍是 recoverable failure', t => {
  const videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-result-attachment-'));
  t.after(() => fs.rmSync(videosDir, { recursive: true, force: true }));
  const one = { ...manifest(), items: [manifest().items[0]], repeatUpdates: { items: [] } };
  fs.mkdirSync(path.join(videosDir, one.items[0].id));
  fs.writeFileSync(path.join(videosDir, one.items[0].id, 'meta.json'), JSON.stringify({ status: 'published', attachment_uploaded: false }));
  assert.equal(collectRunResultItems(one, videosDir)[0].status, 'failure');
});
