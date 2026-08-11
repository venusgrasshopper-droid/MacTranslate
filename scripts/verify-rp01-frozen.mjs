import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const expected = new Map(Object.entries({
  'src/electron/signal': 'cd48192a7734b268042b232977b86819b0c23a32eac87f253d66f96c76d71f54',
  'vendor/signal-runtime': 'd6e07588ed140baa64e0cab31af975d2834bc1777e65f071f35c38e251d85fd0',
  'recipes/recipes/whatsapp': '43a18e798fd6c757a2731aa9cfd3f4a8cc926f4c8067ffe6e928c21ddf7e5f2c',
  'recipes/recipes/telegram': 'a603bc2c461d2197d1fe8bba0e2bf24decc7225bf782c261824be426a027d55c',
  'recipes/recipes/wire': '91823b4de5d4672488af33a7c7682e5795ab6bec47079aca4e2e9303e51da857',
  'recipes/recipes/msteams': '2f68c4d66fdaf4abe3fabce563a80439cf7fbde94ee8be0e82b809091771fe0d',
  'scripts/build-macos-arm64.sh': '9a6a24b8578bc538cc10936843883b8406dc81a902a18fb869a0bfc422c5aa4c',
  'scripts/verify-embedded-signal-source.mjs': '3a798771d7cf64dafa184ef18035a4e06a2d5812fdd49824e1fc42ae378f06a6',
  'scripts/verify-signal-runtime-closure.mjs': 'd03b9fd2606ac1678962b2b2252ef9ae2b31105d37fbbde2f1f7b8ffee9d3d9d',
  'scripts/verify-signal-host-filesystem.mjs': 'c9594f573b0e355a765b0e8a86fecb90d560b3016db1f1b20901c01a1107c3bb',
  'scripts/assemble-trangpt-signal-layout.mjs': '586a4b34b8ceb64a2a7558c0c2bf04cd1d3ccf42cd444511aa5c0832d21256e6',
  'electron-builder.mac-arm64.yml': '3c5919babd5120f947c3fe6277e78256b2dfc68d3d3e270039b4acaa7e424c5c',
}));

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}
function digest(relative) {
  const target = path.join(root, relative);
  if (!existsSync(target)) return 'MISSING';
  const h = createHash('sha256');
  const files = statSync(target).isDirectory() ? walk(target).sort() : [target];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    h.update(rel); h.update('\0'); h.update(readFileSync(file));
    if (files.length > 1) h.update('\0');
  }
  return h.digest('hex');
}
const failures = [];
for (const [relative, wanted] of expected) {
  const actual = digest(relative);
  if (actual !== wanted) failures.push(`${relative}\n  expected ${wanted}\n  actual   ${actual}`);
}
if (failures.length) {
  console.error('RP01_FROZEN_CHECK_FAILED');
  for (const item of failures) console.error(item);
  process.exit(2);
}
console.log('RP01_FROZEN_CHECK_OK');
console.log('Signal host/runtime, Teams/Wire recipes and macOS build pipeline remain RP01; WhatsApp/Telegram recipes are v7.2.2 audited fixes.');
