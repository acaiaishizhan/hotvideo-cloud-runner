#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(ROOT, 'runtime-sync-manifest.json');

function sha256(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const failures = [];

for (const [relativePath, expectedHash] of Object.entries(manifest.files || {})) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    failures.push(`${relativePath}: missing`);
    continue;
  }
  const actualHash = sha256(filePath);
  if (actualHash !== expectedHash) failures.push(`${relativePath}: ${actualHash} != ${expectedHash}`);
}

if (failures.length > 0) {
  console.error('云端运行时与本机真源 hash 不一致:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`运行时 hash 校验通过: ${Object.keys(manifest.files || {}).length} 个文件`);
