import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeJsonAtomic } from './json-file.mjs';

test('writeJsonAtomic replaces an existing JSON file without leaving temp files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"old":true}', 'utf-8');

  writeJsonAtomic(file, { current: true });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { current: true });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
