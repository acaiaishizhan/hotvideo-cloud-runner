import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "cloud-pipeline.yml"), 'utf-8');

test('workflow artifact identity includes run attempt and path-derived queue key', () => {
  assert.match(workflow, /name: run-result-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ steps\.artifact_identity\.outputs\.queue_path_key \}\}/);
  assert.match(workflow, /printf '%s' "\$QUEUE_FILE" \| sha256sum \| cut -c1-16/);
  assert.doesNotMatch(workflow, /hashFiles\(matrix\.queue_file\)/);
  assert.match(workflow, /retention-days: 90/);
});

test('push prepare selects the complete before..head range so two local commits both enter matrix', () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(workflow, /git diff --name-only "\$PUSH_BEFORE_SHA" "\$GITHUB_SHA" -- 'queue\/\*\.json'/);
  assert.doesNotMatch(workflow, /git diff-tree --no-commit-id --name-only -r "\$GITHUB_SHA"/);
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
