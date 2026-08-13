#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const runtimeFlag = args.indexOf('--runtime');
const runtimeRoot = path.resolve(
  runtimeFlag >= 0 && args[runtimeFlag + 1]
    ? args[runtimeFlag + 1]
    : 'vendor/signal-runtime',
);
const manifestPath = path.join(runtimeRoot, 'mactranslate-closure.json');
const failures = [];

function fail(message) {
  failures.push(message);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read JSON ${file}: ${error.message}`);
    return null;
  }
}
function requireFile(relative) {
  const file = path.join(runtimeRoot, relative);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fail(`Missing runtime file: ${relative}`);
  }
  return file;
}

if (!fs.existsSync(manifestPath)) {
  console.error(`Signal closure manifest is missing: ${manifestPath}`);
  process.exit(1);
}
const manifest = readJson(manifestPath);
if (!manifest) process.exit(1);

const exactAssetManifestRelative =
  manifest.trangptAssetManifest ?? 'mactranslate-trangpt-assets.json';
const exactAssetManifestPath = path.join(runtimeRoot, exactAssetManifestRelative);
const exactAssetManifest = readJson(exactAssetManifestPath);
if (exactAssetManifest) {
  const entries = Object.entries(exactAssetManifest.sha256 ?? {});
  if (
    Number.isInteger(exactAssetManifest.fileCount) &&
    entries.length !== exactAssetManifest.fileCount
  ) {
    fail(
      `TranGPT asset manifest count mismatch: expected ${exactAssetManifest.fileCount}, got ${entries.length}`,
    );
  }
  for (const [manifestRelative, expectedHash] of entries) {
    const relative = manifestRelative.startsWith('@root/')
      ? path.join('node_modules', manifestRelative.slice('@root/'.length))
      : manifestRelative;
    const file = path.join(runtimeRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      fail(`Missing exact TranGPT Signal asset: ${manifestRelative}`);
      continue;
    }
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    if (actualHash !== expectedHash) {
      fail(`Exact TranGPT Signal asset hash mismatch: ${manifestRelative}`);
    }
  }
}

for (const relative of manifest.requiredFiles ?? []) {
  requireFile(relative);
}

for (const [relative, expectedHash] of Object.entries(
  manifest.trangptRuntimeSha256 ?? {},
)) {
  const file = requireFile(relative);
  if (fs.existsSync(file)) {
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    if (actualHash !== expectedHash) {
      fail(`TranGPT Signal runtime hash mismatch: ${relative}`);
    }
  }
}


const preloadManifestRelative =
  manifest.trangptServicePreloadManifest ?? 'mactranslate-trangpt-preload.json';
const preloadManifestPath = path.join(runtimeRoot, preloadManifestRelative);
const preloadManifest = readJson(preloadManifestPath);
if (preloadManifest) {
  const entries = Object.entries(preloadManifest.sha256 ?? {});
  if (entries.length !== preloadManifest.fileCount) {
    fail(`TranGPT preload manifest count mismatch: expected ${preloadManifest.fileCount}, got ${entries.length}`);
  }
  for (const [relative, expectedHash] of entries) {
    const file = path.join(runtimeRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      fail(`Missing exact TranGPT preload file: ${relative}`);
      continue;
    }
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actualHash !== expectedHash) {
      fail(`Exact TranGPT preload hash mismatch: ${relative}`);
    }
  }
  for (const [name, expectedVersion] of Object.entries(preloadManifest.dependencies ?? {})) {
    const packageJson = readJson(path.join(runtimeRoot, 'preload', 'node_modules', name, 'package.json'));
    if (!packageJson) continue;
    if (packageJson.name !== name || packageJson.version !== expectedVersion) {
      fail(`TranGPT preload package mismatch for ${name}: expected ${expectedVersion}, got ${packageJson?.version}`);
    }
  }
}

const packageJsonByName = new Map();
for (const [name, expectedVersion] of Object.entries(manifest.packages ?? {})) {
  const packageJsonPath = path.join(runtimeRoot, 'node_modules', name, 'package.json');
  const packageJson = readJson(packageJsonPath);
  if (!packageJson) continue;
  packageJsonByName.set(name, packageJson);
  if (packageJson.name !== name) {
    fail(`Package name mismatch at ${name}: ${packageJson.name}`);
  }
  if (packageJson.version !== expectedVersion) {
    fail(`Package version mismatch for ${name}: expected ${expectedVersion}, got ${packageJson.version}`);
  }
}

// Validate every declared production dependency in the vendored Signal tree.
// RingRTC's `tar` entry is used only by its prebuild-fetch script and is not
// present in the mature packaged application, so it is explicitly excluded.
const ignoredDeclaredDependencies = manifest.ignoredDeclaredDependencies ?? {};
const signalPackage = readJson(path.join(runtimeRoot, 'package.json'));
const dependencyOwners = new Map([['signal-desktop', signalPackage], ...packageJsonByName]);
for (const [owner, packageJson] of dependencyOwners) {
  if (!packageJson) continue;
  const ignored = new Set(ignoredDeclaredDependencies[owner] ?? []);
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
  for (const dependencyName of Object.keys(dependencies)) {
    if (ignored.has(dependencyName)) continue;
    const dependencyPackage = path.join(
      runtimeRoot,
      'node_modules',
      dependencyName,
      'package.json',
    );
    if (!fs.existsSync(dependencyPackage)) {
      fail(`Declared runtime dependency is missing: ${owner} -> ${dependencyName}`);
    }
  }
}

const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
for (const specifier of manifest.resolvableAtRuntime ?? []) {
  try {
    runtimeRequire.resolve(specifier);
  } catch (error) {
    fail(`Runtime module cannot be resolved: ${specifier} (${error.message})`);
  }
}

for (const [globalName, contract] of Object.entries(manifest.hostGlobals ?? {})) {
  const provider = contract?.provider;
  if (typeof provider !== 'string' || provider.length === 0) {
    fail(`Host global provider is invalid: ${globalName}`);
    continue;
  }
  try {
    runtimeRequire(provider);
  } catch (error) {
    fail(`Host global provider failed to load: ${globalName} <- ${provider} (${error.message})`);
    continue;
  }
  const requiredType = contract?.requiredType ?? 'function';
  if (typeof globalThis[globalName] !== requiredType) {
    fail(`Host global is unavailable after loading ${provider}: ${globalName}`);
  }
}

for (const relative of manifest.nativeFiles ?? []) {
  const file = requireFile(relative);
  if (fs.existsSync(file)) {
    const expectedHash = manifest.nativeSha256?.[relative];
    if (typeof expectedHash === 'string') {
      const actualHash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex');
      if (actualHash !== expectedHash) {
        fail(`Native module hash mismatch: ${relative}`);
      }
    }
  }
  if (process.platform === 'darwin' && fs.existsSync(file)) {
    let arches = '';
    try {
      arches = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim();
    } catch {
      try {
        arches = execFileSync('file', ['-b', file], { encoding: 'utf8' }).trim();
      } catch {
        arches = '';
      }
    }
    if (!/(^|\s)arm64(\s|$)/.test(arches)) {
      fail(`Native module is not Apple Silicon arm64: ${relative} (${arches || 'unknown'})`);
    }
  }
}

// Verify the exact native loader dependencies that caused v8 to fail.
const loaderChecks = [
  ['node_modules/@signalapp/libsignal-client/dist/Native.js', /node-gyp-build/],
  ['node_modules/@signalapp/sqlcipher/dist/index.cjs', /node-gyp-build/],
  ['node_modules/@indutny/mac-screen-share/index.js', /bindings/],
  ['node_modules/bindings/bindings.js', /file-uri-to-path/],
];
for (const [relative, pattern] of loaderChecks) {
  const file = requireFile(relative);
  if (fs.existsSync(file) && !pattern.test(fs.readFileSync(file, 'utf8'))) {
    fail(`Expected native loader dependency is absent from ${relative}`);
  }
}

if (failures.length > 0) {
  console.error('Signal runtime closure verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Signal runtime closure verified: ${runtimeRoot}`);
console.log(`Packages: ${Object.keys(manifest.packages ?? {}).length}`);
console.log(`Preload files: ${preloadManifest?.fileCount ?? 0}`);
console.log(`Native modules: ${(manifest.nativeFiles ?? []).length}`);
