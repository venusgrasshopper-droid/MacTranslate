#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];

function file(relative) {
  return path.join(root, relative);
}
function read(relative) {
  try {
    return fs.readFileSync(file(relative), 'utf8');
  } catch {
    failures.push(`Missing file: ${relative}`);
    return '';
  }
}
function requireFile(relative) {
  const target = file(relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size === 0) {
    failures.push(`Missing or empty file: ${relative}`);
  }
}
function requirePattern(relative, pattern, message) {
  if (!pattern.test(read(relative))) failures.push(message);
}
function forbidPattern(relative, pattern, message) {
  if (pattern.test(read(relative))) failures.push(message);
}
function sha256(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(file(relative))).digest('hex');
}

[
  'src/electron/signal/EmbeddedSignalEngine.ts',
  'src/electron/signal/SignalRuntimeHost.ts',
  'src/electron/signal/runEmbeddedSignalSmokeTest.ts',
  'src/electron/signal/TranGPTPreloadIpc.ts',
  'src/electron/ipc-api/signalHost.ts',
  'src/components/services/content/SignalHostView.tsx',
  'recipes/recipes/signal/package.json',
  'recipes/recipes/signal/index.js',
  'scripts/assemble-trangpt-signal-layout.mjs',
  'scripts/verify-signal-runtime-closure.mjs',
  'scripts/verify-signal-host-filesystem.mjs',
  'vendor/signal-runtime/mactranslate-main-bootstrap.cjs',
  'vendor/signal-runtime/mactranslate-main-directories.cjs',
  'vendor/signal-runtime/mactranslate-main-globals.cjs',
  'vendor/signal-runtime/bundles/main.js',
  'vendor/signal-runtime/bundles/preload/wrapper.js',
  'vendor/signal-runtime/bundles/preload/main.js',
  'vendor/signal-runtime/preload/servicePreloadSignal.js',
  'vendor/signal-runtime/preload/js/index.js',
  'vendor/signal-runtime/preload/js/index2.js',
  'vendor/signal-runtime/preload/js/base64.js',
  'vendor/signal-runtime/preload/node_modules/@electron-toolkit/preload/package.json',
  'vendor/signal-runtime/preload/node_modules/react/package.json',
  'vendor/signal-runtime/preload/node_modules/react-dom/package.json',
  'vendor/signal-runtime/preload/node_modules/scheduler/package.json',
  'vendor/signal-runtime/mactranslate-trangpt-preload.json',
  'vendor/signal-runtime/background.html',
  'vendor/signal-runtime/build/available-locales.json',
  'vendor/signal-runtime/build/optional-resources.json',
].forEach(requireFile);

const packageJson = JSON.parse(read('package.json') || '{}');
if (packageJson.name !== 'mactranslate') failures.push('package.json name is not mactranslate.');
if (packageJson.devDependencies?.electron !== '38.1.0') failures.push('Electron must be 38.1.0.');
if (packageJson.devDependencies?.['@electron/asar'] !== '3.4.1') failures.push('@electron/asar must be 3.4.1.');

requirePattern(
  'src/index.ts',
  /prepareEmbeddedSignalBeforeReady\(\)[\s\S]*app\.on\(['"]ready['"]/, 
  'Signal main must load before Electron ready.',
);
requirePattern(
  'src/electron/signal/EmbeddedSignalEngine.ts',
  /__mactranslateSignalMainReady\s*===\s*true/,
  'Signal host does not wait for TranGPT main initialization.',
);
requirePattern(
  'src/electron/signal/EmbeddedSignalEngine.ts',
  /const virtualPreloadEntry = join\(root, preloadRelative\)[\s\S]*preloadEntry: virtualPreloadEntry/,
  'Packaged Signal preload must keep the app.asar virtual path used by TranGPT.',
);
forbidPattern(
  'src/electron/signal/EmbeddedSignalEngine.ts',
  /preloadEntry:\s*existsSync\(unpackedPreloadEntry\)/,
  'Signal preload incorrectly uses the physical app.asar.unpacked path.',
);
forbidPattern(
  'src/electron/signal/EmbeddedSignalEngine.ts',
  /createContext|runInNewContext|node:vm/,
  'Obsolete VM Signal host remains.',
);
requirePattern(
  'src/electron/signal/SignalRuntimeHost.ts',
  /new WebContentsView[\s\S]*preload:\s*this\.paths\.preloadEntry[\s\S]*nodeIntegration:\s*false[\s\S]*nodeIntegrationInWorker:\s*false[\s\S]*contextIsolation:\s*true[\s\S]*sandbox:\s*false/,
  'Signal WebContentsView does not use the TranGPT preload with the official Signal 8.x isolated host mode.',
);
requirePattern(
  'src/electron/signal/SignalRuntimeHost.ts',
  /persist:mactranslate-signal-\$\{this\.serviceId\}/,
  'Signal account partitions are not isolated.',
);
requirePattern(
  'src/electron/signal/SignalRuntimeHost.ts',
  /registerProtocolFor[\s\S]*initSql[\s\S]*loadFile/,
  'Signal startup order is incorrect.',
);
requirePattern(
  'src/electron/signal/SignalRuntimeHost.ts',
  /send\(['"]set-user-id['"],\s*this\.serviceId\)/,
  'TranGPT Signal renderer start message is missing.',
);
requirePattern(
  'src/electron/signal/TranGPTPreloadIpc.ts',
  /app:getVersion[\s\S]*app:getSettings[\s\S]*appService:getSelfSession[\s\S]*notification:send/,
  'TranGPT service preload IPC compatibility handlers are incomplete.',
);
requirePattern(
  'src/electron/signal/runEmbeddedSignalSmokeTest.ts',
  /installTranGPTPreloadIpc\(window\)[\s\S]*new SignalRuntimeHost/,
  'Signal smoke test does not install TranGPT preload IPC before account startup.',
);
requirePattern(
  'src/electron/signal/runEmbeddedSignalSmokeTest.ts',
  /runHomepageWebviewSmokeTest\(\)[\s\S]*did-attach-webview[\s\S]*HOMEPAGE_WEBVIEW_SMOKE_OK/,
  'Homepage service webview is not tested before Signal startup.',
);
requirePattern(
  'src/components/services/content/ServiceWebview.tsx',
  /import ElectronWebView from 'react-electron-web-view'[\s\S]*<ElectronWebView/,
  'Original Ferdium service Webview implementation was not preserved.',
);
forbidPattern(
  'src/electron/signal/SignalRuntimeHost.ts',
  /hostPreload\.js/,
  'The obsolete custom Signal preload is still referenced.',
);

const exactPreload = read('vendor/signal-runtime/preload/servicePreloadSignal.js');
for (const token of [
  'innerElectronApi',
  'customApi',
  'ipcMainFeatures',
  'window.isSignal=!0',
  'initFingerprintBootstrap()',
  'initBehaviour()',
  'bundles/preload/wrapper.js',
]) {
  if (!exactPreload.includes(token)) failures.push(`TranGPT service preload token is missing: ${token}`);
}

const preloadManifest = JSON.parse(read('vendor/signal-runtime/mactranslate-trangpt-preload.json') || '{}');
const preloadEntries = Object.entries(preloadManifest.sha256 ?? {});
if (preloadEntries.length !== preloadManifest.fileCount) failures.push('TranGPT preload manifest count mismatch.');
for (const [relative, expected] of preloadEntries) {
  requireFile(`vendor/signal-runtime/${relative}`);
  if (fs.existsSync(file(`vendor/signal-runtime/${relative}`)) && sha256(`vendor/signal-runtime/${relative}`) !== expected) {
    failures.push(`TranGPT preload hash mismatch: ${relative}`);
  }
}

requirePattern(
  'vendor/signal-runtime/bundles/main.js',
  /Uy=await ib\(\),vx=!0,globalThis\.__mactranslateSignalMainReady=!0/,
  'Signal readiness marker is not at the end of TranGPT app.ready initialization.',
);
requirePattern(
  'vendor/signal-runtime/bundles/main.js',
  /Zy&&f\.app\.on\(`web-contents-created`,\(e,t\)=>\{t\.on\(`will-attach-webview`,e=>\{e\.preventDefault\(\)\}\),t\.setWindowOpenHandler/,
  'Embedded Signal still blocks MacTranslate service webviews.',
);
forbidPattern(
  'vendor/signal-runtime/bundles/main.js',
  /(?<!Zy&&)f\.app\.on\(`web-contents-created`,\(e,t\)=>\{t\.on\(`will-attach-webview`,e=>\{e\.preventDefault\(\)\}\)/,
  'Signal webview blocker is still registered globally in embedded mode.',
);
forbidPattern(
  'vendor/signal-runtime/bundles/main.js',
  /Ny\|\|\(Ny=d_\.create/,
  'Signal main contains the old non-TranGPT OptionalResourceService modification.',
);

requirePattern(
  'scripts/build-macos-arm64.sh',
  /--dir[\s\S]*assemble-trangpt-signal-layout[\s\S]*--signal-smoke-test[\s\S]*--prepackaged/,
  'Build order is not app -> Signal assembly -> smoke test -> DMG.',
);
requirePattern(
  'scripts/assemble-trangpt-signal-layout.mjs',
  /signal-runtime\/preload\/\*\*/,
  'TranGPT Signal preload tree is not forced into app.asar.unpacked.',
);
requirePattern(
  'electron-builder.mac-arm64.yml',
  /MacTranslate-v12\.4\.3-/,
  'Artifact version is not v12.4.3.',
);

if (failures.length) {
  console.error('Embedded Signal source verification failed:');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}

console.log('Embedded Signal source verification passed.');
