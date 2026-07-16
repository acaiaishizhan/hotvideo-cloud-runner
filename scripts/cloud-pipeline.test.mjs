import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "cloud-pipeline.yml"), 'utf-8');

test('workflow uses immutable unique artifact names and 90-day retention', () => {
  assert.match(workflow, /name: run-result-\$\{\{ github\.run_id \}\}-\$\{\{ hashFiles\(matrix\.queue_file\) \}\}/);
  assert.match(workflow, /retention-days: 90/);
});

test('workflow always uploads the envelope and fails when it is missing', () => {
  assert.match(workflow, /name: Upload terminal run-result envelope\s+if: always\(\)/);
  assert.match(workflow, /if-no-files-found: error/);
});

test('workflow keeps queue:max and exposes manual queue identity for missing-artifact replay', () => {
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /run-name: hotvideo-\$\{\{ inputs\.queue_file \|\| github\.sha \}\}/);
  assert.match(workflow, /name: process-\$\{\{ matrix\.queue_file \}\}/);
});
