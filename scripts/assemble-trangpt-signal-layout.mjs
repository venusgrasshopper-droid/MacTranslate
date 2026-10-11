#!/usr/bin/env node

import * as asar from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const appFlag = args.indexOf('--app');
if (appFlag < 0 || !args[appFlag + 1]) {
  console.error('Usage: assemble-trangpt-signal-layout.mjs --app /path/to/MacTranslate.app');
  process.exit(1);
}

const projectRoot = process.cwd();
const appPath = path.resolve(args[appFlag + 1]);
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const appAsarPath = path.join(resourcesPath, 'app.asar');
const appAsarUnpackedPath = `${appAsarPath}.unpacked`;
const runtimeSource = path.join(projectRoot, 'vendor', 'signal-runtime');
const runtimeNodeModules = path.join(runtimeSource, 'node_modules');

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function requireFile(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fail(`Required file is missing: ${file}`);
  }
}

requireFile(appAsarPath);
requireFile(path.join(runtimeSource, 'mactranslate-runtime.json'));
requireFile(path.join(runtimeSource, 'mactranslate-closure.json'));
if (!fs.existsSync(runtimeNodeModules)) {
  fail(`Signal runtime dependencies are missing: ${runtimeNodeModules}`);
}

const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mactranslate-v11-asar.'));
const stagingApp = path.join(stagingRoot, 'app');
fs.mkdirSync(stagingApp, { recursive: true });

try {
  // Extract the app produced by electron-builder, including its normal runtime
  // dependencies. Overlay the existing unpacked tree so all original Ferdium
  // native assets survive the final repack.
  asar.extractAll(appAsarPath, stagingApp);
  if (fs.existsSync(appAsarUnpackedPath)) {
    fs.cpSync(appAsarUnpackedPath, stagingApp, {
      recursive: true,
      dereference: true,
      force: true,
    });
  }

  const stagedSignalRoot = path.join(stagingApp, 'signal-runtime');
  fs.rmSync(stagedSignalRoot, { recursive: true, force: true });
  fs.mkdirSync(stagedSignalRoot, { recursive: true });

  // Signal application files live inside app.asar/signal-runtime. Dependencies
  // are placed exactly like the mature TranGPT package:
  //   app.asar/node_modules/*                         pure JS helpers
  //   app.asar.unpacked/signal-runtime/node_modules/@signalapp/*
  //                                                     Signal native packages
  //   app.asar.unpacked/node_modules/**/.node          root native payloads
  for (const entry of fs.readdirSync(runtimeSource, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    fs.cpSync(
      path.join(runtimeSource, entry.name),
      path.join(stagedSignalRoot, entry.name),
      { recursive: true, dereference: true, force: true },
    );
  }

  const stagedRootNodeModules = path.join(stagingApp, 'node_modules');
  const stagedSignalNodeModules = path.join(stagedSignalRoot, 'node_modules');
  fs.mkdirSync(stagedRootNodeModules, { recursive: true });
  fs.mkdirSync(stagedSignalNodeModules, { recursive: true });

  for (const entry of fs.readdirSync(runtimeNodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(runtimeNodeModules, entry.name);

    if (entry.name === '@signalapp') {
      const destination = path.join(stagedSignalNodeModules, '@signalapp');
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(source, destination, {
        recursive: true,
        dereference: true,
        force: true,
      });
      continue;
    }

    if (entry.name.startsWith('@')) {
      const scopeDestination = path.join(stagedRootNodeModules, entry.name);
      fs.mkdirSync(scopeDestination, { recursive: true });
      for (const packageEntry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!packageEntry.isDirectory()) continue;
        const destination = path.join(scopeDestination, packageEntry.name);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(path.join(source, packageEntry.name), destination, {
          recursive: true,
          dereference: true,
          force: true,
        });
      }
      continue;
    }

    const destination = path.join(stagedRootNodeModules, entry.name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: true,
      force: true,
    });
  }

  const requiredStagedFiles = [
    'signal-runtime/bundles/main.js',
    'signal-runtime/bundles/preload/wrapper.js',
    'signal-runtime/preload/servicePreloadSignal.js',
    'signal-runtime/preload/js/index.js',
    'signal-runtime/preload/js/index2.js',
    'signal-runtime/preload/js/base64.js',
    'signal-runtime/preload/node_modules/@electron-toolkit/preload/package.json',
    'signal-runtime/preload/node_modules/react/package.json',
    'signal-runtime/preload/node_modules/react-dom/package.json',
    'signal-runtime/preload/node_modules/scheduler/package.json',
    'signal-runtime/mactranslate-trangpt-preload.json',
    'signal-runtime/background.html',
    'signal-runtime/mactranslate-trangpt-assets.json',
    'signal-runtime/build/available-locales.json',
    'signal-runtime/build/country-display-names.json',
    'signal-runtime/build/dns-fallback.json',
    'signal-runtime/build/emoji-data.json',
    'signal-runtime/build/jumbomoji.json',
    'signal-runtime/build/locale-display-names.json',
    'signal-runtime/build/optional-resources.json',
    'signal-runtime/build/icons/png/512x512.png',
    'signal-runtime/build/icons/win/icon.ico',
    'signal-runtime/node_modules/@signalapp/libsignal-client/package.json',
    'signal-runtime/node_modules/@signalapp/sqlcipher/package.json',
    'node_modules/node-gyp-build/package.json',
    'node_modules/bindings/package.json',
    'node_modules/file-uri-to-path/package.json',
    'node_modules/@indutny/mac-screen-share/package.json',
    'node_modules/fs-xattr/package.json',
  ];
  for (const relative of requiredStagedFiles) {
    requireFile(path.join(stagingApp, relative));
  }

  fs.rmSync(appAsarPath, { force: true });
  fs.rmSync(appAsarUnpackedPath, { recursive: true, force: true });

  const unpackPattern = [
    'recipes/**',
    'assets/fonts/**',
    'assets/images/taskbar/**',
    'assets/images/icons/**',
    'signal-runtime/node_modules/@signalapp/**',
    'signal-runtime/preload/**',
    '**/*.node',
    '**/*.dylib',
  ].join(',');

  await asar.createPackageWithOptions(stagingApp, appAsarPath, {
    unpack: `{${unpackPattern}}`,
    // MacTranslate resolves recipes through app.asar.unpacked explicitly.
    // Use unpackDir for the whole directory; unpack only matches file globs.
    unpackDir: 'recipes',
  });

  // Defensive fallback: @electron/asar versions/glob behavior must never leave
  // the runtime without app.asar.unpacked/recipes. The external copy is safe
  // even when unpackDir already worked, because it contains the same files.
  const stagedRecipes = path.join(stagingApp, 'recipes');
  const unpackedRecipes = path.join(appAsarUnpackedPath, 'recipes');
  requireFile(path.join(stagedRecipes, 'all.json'));
  requireFile(path.join(stagedRecipes, 'signal.tar.gz'));
  fs.rmSync(unpackedRecipes, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(unpackedRecipes), { recursive: true });
  fs.cpSync(stagedRecipes, unpackedRecipes, {
    recursive: true,
    dereference: true,
    force: true,
  });

  // TranGPT loads servicePreloadSignal from app.asar.unpacked. Keep an exact
  // real-filesystem copy so Electron's preload loader and its local requires
  // never depend on asar virtual-path behavior.
  const stagedTranGPTPreload = path.join(stagedSignalRoot, 'preload');
  const unpackedTranGPTPreload = path.join(
    appAsarUnpackedPath,
    'signal-runtime',
    'preload',
  );
  requireFile(path.join(stagedTranGPTPreload, 'servicePreloadSignal.js'));
  fs.rmSync(unpackedTranGPTPreload, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(unpackedTranGPTPreload), { recursive: true });
  fs.cpSync(stagedTranGPTPreload, unpackedTranGPTPreload, {
    recursive: true,
    dereference: true,
    force: true,
  });

  // The macOS translation helper is spawned as a real executable, so it must
  // exist on the real filesystem next to app.asar (see macos-translation-native).
  const helperRelative = path.join(
    'assets',
    'images',
    'icons',
    'mactranslate-translation-helper',
  );
  const stagedHelper = path.join(stagingApp, helperRelative);
  const unpackedHelper = path.join(appAsarUnpackedPath, helperRelative);
  requireFile(stagedHelper);
  fs.mkdirSync(path.dirname(unpackedHelper), { recursive: true });
  fs.copyFileSync(stagedHelper, unpackedHelper);
  fs.chmodSync(unpackedHelper, 0o755);

  requireFile(appAsarPath);
  requireFile(unpackedHelper);
  requireFile(path.join(unpackedRecipes, 'all.json'));
  requireFile(path.join(unpackedRecipes, 'signal.tar.gz'));
  requireFile(
    path.join(
      appAsarUnpackedPath,
      'signal-runtime',
      'preload',
      'servicePreloadSignal.js',
    ),
  );
  requireFile(
    path.join(
      appAsarUnpackedPath,
      'signal-runtime',
      'preload',
      'node_modules',
      '@electron-toolkit',
      'preload',
      'package.json',
    ),
  );
  requireFile(
    path.join(
      appAsarUnpackedPath,
      'signal-runtime',
      'node_modules',
      '@signalapp',
      'libsignal-client',
      'prebuilds',
      'darwin-arm64',
      '@signalapp+libsignal-client.node',
    ),
  );
  requireFile(
    path.join(
      appAsarUnpackedPath,
      'node_modules',
      '@indutny',
      'mac-screen-share',
      'prebuilds',
      'darwin-arm64',
      '@indutny+mac-screen-share.node',
    ),
  );
  requireFile(
    path.join(
      appAsarUnpackedPath,
      'node_modules',
      'fs-xattr',
      'build',
      'Release',
      'xattr.node',
    ),
  );

  console.log('Embedded Signal app.asar layout assembled successfully.');
  console.log(`Application: ${appPath}`);
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
