#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const runtimeRoot = path.resolve('vendor/signal-runtime');
const helperPath = path.join(runtimeRoot, 'mactranslate-main-directories.cjs');
const runtimeRequire = createRequire(helperPath);
const { prepareSignalHostDirectories } = runtimeRequire(helperPath);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mactranslate-signal-host-preflight.'));

try {
  const first = prepareSignalHostDirectories(root);
  const expected = path.join(root, 'signals');
  if (first.signalsPath !== expected || !fs.statSync(expected).isDirectory()) {
    throw new Error('Signal userData/signals directory was not created correctly.');
  }

  const sentinel = path.join(expected, 'sentinel.json');
  fs.writeFileSync(sentinel, '{"preserve":true}', { mode: 0o600 });
  const second = prepareSignalHostDirectories(root);
  if (second.signalsPath !== expected || fs.readFileSync(sentinel, 'utf8') !== '{"preserve":true}') {
    throw new Error('Signal directory preparation is not idempotent or removed existing data.');
  }

  const temp = path.join(expected, `ephemeral.json.${process.pid}`);
  const final = path.join(expected, 'ephemeral.json');
  fs.writeFileSync(temp, '{}', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, final);
  if (fs.readFileSync(final, 'utf8') !== '{}') {
    throw new Error('Signal atomic sibling-file write simulation failed.');
  }

  console.log('Signal host filesystem preflight passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
