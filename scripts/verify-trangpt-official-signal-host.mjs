#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostPath = path.join(root, 'src/electron/signal/SignalRuntimeHost.ts');
const runtime = path.join(root, 'vendor/signal-runtime');

function fail(message) {
  console.error(`SIGNAL_HOST_VERIFY_FAILED ${message}`);
  process.exit(1);
}
function requireText(text, needle, label) {
  if (!text.includes(needle)) fail(`missing ${label}: ${needle}`);
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const host = fs.readFileSync(hostPath, 'utf8');
for (const [needle, label] of [
  ['nodeIntegration: false', 'nodeIntegration=false'],
  ['nodeIntegrationInWorker: false', 'nodeIntegrationInWorker=false'],
  ['contextIsolation: true', 'contextIsolation=true'],
  ['sandbox: false', 'sandbox=false'],
  ['backgroundThrottling: true', 'backgroundThrottling=true'],
  ["enableBlinkFeatures: 'CSSPseudoDir,CSSLogical'", 'Signal Blink features'],
  ['enablePreferredSizeMode: true', 'preferred size mode'],
  ["'Accelerated2dCanvas,AcceleratedSmallCanvases'", 'Signal disabled canvas features'],
]) {
  requireText(host, needle, label);
}
if (host.includes('contextIsolation: false')) fail('legacy contextIsolation=false remains');

const expected = new Map([
  ['preload/servicePreloadSignal.js', '209def51757da1fbd2a3e034df753edb89d4e397a9eb8de521a7c855a5cfb7b6'],
  ['preload/js/index.js', 'e9ebf02eb0400c66fe0d8c6f98d9139e53e9f159cab761ccd45274bb0b590713'],
  ['preload/js/index2.js', '7432232ca0407c37f4c8190811bffc8abe41558611a32985b640a53d030ac4f5'],
  ['preload/js/base64.js', 'd9b75d421d3f762c35285d53a71397e4de593e4d718ce5ff59ce1dc983e1e87a'],
  ['bundles/preload/wrapper.js', '83631d30a473801844dffc782e04d029a0de7dd0df155860df94fe4466898bee'],
  ['bundles/preload/main.js', 'abcca323a64f17dacad623b67837a8b00d28410d86f2210a96c0ec903832bd45'],
]);
for (const [relative, wanted] of expected) {
  const file = path.join(runtime, relative);
  if (!fs.existsSync(file)) fail(`missing TranGPT runtime file: ${relative}`);
  const actual = sha256(file);
  if (actual !== wanted) fail(`${relative} hash differs: ${actual}`);
}
console.log('SIGNAL_TRANGPT_OFFICIAL_HOST_OK contextIsolation=true sandbox=false exactPreload=true');
