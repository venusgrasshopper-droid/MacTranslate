#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const manifestPath = path.join(root, 'FROZEN_SOURCE_MANIFEST_V6.sha256');
const failures = [];
const lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/);
  if (!match) { failures.push(`bad manifest line: ${line}`); continue; }
  const [, expected, relative] = match;
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) { failures.push(`missing frozen file: ${relative}`); continue; }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  if (actual !== expected) failures.push(`changed frozen file: ${relative}`);
}
if (failures.length) {
  console.error('V6_FROZEN_MANIFEST_CHECK_FAILED');
  failures.slice(0, 100).forEach(item => console.error(`- ${item}`));
  if (failures.length > 100) console.error(`... ${failures.length - 100} more`);
  process.exit(1);
}
console.log(`V6_FROZEN_MANIFEST_CHECK_OK files=${lines.length}`);
