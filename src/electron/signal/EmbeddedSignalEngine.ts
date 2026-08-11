/* eslint-disable import/no-dynamic-require */
/* eslint-disable global-require */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { app, ipcMain, type Session, type WebContents } from 'electron';

const debug = require('../../preload-safe-debug')(
  'MacTranslate:EmbeddedSignalEngine',
);

interface SignalRuntimeMetadata {
  signalVersion?: string;
  electronVersion?: string;
  mainEntry?: string;
  preloadEntry?: string;
  backgroundEntry?: string;
  source?: string;
}

export interface EmbeddedSignalRuntimePaths {
  root: string;
  mainEntry: string;
  preloadEntry: string;
  backgroundEntry: string;
  metadataEntry: string;
  packageEntry: string;
  version: string | null;
  electronVersion: string | null;
}

interface EmbeddedSignalGlobals {
  registerProtocolFor?: (session: Session, userId: string) => Promise<void>;
  initSql?: (userId: string) => Promise<void>;
  parseSignalRoute?: (url: string) => unknown;
  handleSignalRoute?: (route: unknown, sender?: WebContents) => void;
  handleCaptcha?: (captchaId: string, sender?: WebContents) => void;
  __mactranslateSignalMainReady?: boolean;
}

const accountByWebContentsId = new Map<number, string>();
let prepareAttempted = false;
let prepareError: Error | null = null;
let runtimePathsCache: EmbeddedSignalRuntimePaths | null = null;
let getUserIdHandlerInstalled = false;

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function runtimeCandidates(): string[] {
  return unique([
    process.env.MACTRANSLATE_SIGNAL_RUNTIME,
    // Packaged application: JavaScript runtime lives inside app.asar.
    join(process.resourcesPath, 'app.asar', 'signal-runtime'),
    // Development/build output: build/electron/signal -> build/signal-runtime.
    join(__dirname, '..', '..', 'signal-runtime'),
    // Compatibility fallback for an unpacked runtime during local inspection.
    join(process.resourcesPath, 'signal-runtime'),
    join(process.cwd(), 'vendor', 'signal-runtime'),
  ]);
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getEmbeddedSignalRuntimePaths(): EmbeddedSignalRuntimePaths {
  if (runtimePathsCache) {
    return runtimePathsCache;
  }

  const root =
    runtimeCandidates().find(candidate =>
      existsSync(join(candidate, 'mactranslate-runtime.json')),
    ) ?? runtimeCandidates()[0];
  const metadataEntry = join(root, 'mactranslate-runtime.json');
  const packageEntry = join(root, 'package.json');
  const metadata = readJson(metadataEntry) as SignalRuntimeMetadata;
  const packageJson = readJson(packageEntry);

  const mainRelative =
    metadata.mainEntry ??
    (typeof packageJson.main === 'string'
      ? packageJson.main
      : join('bundles', 'main.js'));
  const preloadRelative =
    metadata.preloadEntry ?? join('bundles', 'preload', 'wrapper.js');
  const backgroundRelative = metadata.backgroundEntry ?? 'background.html';

  // Keep the preload path inside the app.asar namespace. Electron resolves
  // unpacked preload files transparently, while __dirname remains the virtual
  // app.asar path used by TranGPT. That lets servicePreloadSignal.js locate
  // ../bundles/preload/wrapper.js exactly as it does in the finished app.
  const virtualPreloadEntry = join(root, preloadRelative);

  runtimePathsCache = {
    root,
    mainEntry: join(root, mainRelative),
    preloadEntry: virtualPreloadEntry,
    backgroundEntry: join(root, backgroundRelative),
    metadataEntry,
    packageEntry,
    version:
      metadata.signalVersion ??
      (typeof packageJson.version === 'string' ? packageJson.version : null),
    electronVersion: metadata.electronVersion ?? null,
  };

  return runtimePathsCache;
}

function installGetUserIdHandler(): void {
  if (getUserIdHandlerInstalled) {
    return;
  }
  getUserIdHandlerInstalled = true;

  ipcMain.on('get-user-id', event => {
    event.returnValue = accountByWebContentsId.get(event.sender.id) ?? '';
  });
}

export function bindSignalWebContents(
  webContents: WebContents,
  accountId: string,
): void {
  accountByWebContentsId.set(webContents.id, accountId);
  webContents.once('destroyed', () => {
    accountByWebContentsId.delete(webContents.id);
  });
}

export function unbindSignalWebContents(webContents: WebContents): void {
  accountByWebContentsId.delete(webContents.id);
}

export function getSignalAccountIdForWebContents(
  webContents: WebContents,
): string | null {
  return accountByWebContentsId.get(webContents.id) ?? null;
}

function globals(): EmbeddedSignalGlobals {
  return globalThis as typeof globalThis & EmbeddedSignalGlobals;
}

function validateRuntime(paths: EmbeddedSignalRuntimePaths): void {
  const missing = [
    paths.mainEntry,
    paths.preloadEntry,
    paths.backgroundEntry,
    paths.packageEntry,
  ].filter(path => !existsSync(path));

  if (missing.length > 0) {
    throw new Error(
      `Signal runtime is incomplete: ${missing.map(path => basename(path)).join(', ')}`,
    );
  }

  if (
    paths.electronVersion &&
    paths.electronVersion !== process.versions.electron
  ) {
    throw new Error(
      `Signal runtime requires Electron ${paths.electronVersion}, current Electron is ${process.versions.electron}.`,
    );
  }
}

/**
 * Must be called while Electron is still in the pre-ready phase. Signal's
 * embedded main bundle registers privileged schemes before app.ready and then
 * completes its initialization from its own app.ready listener.
 */
export function prepareEmbeddedSignalBeforeReady(): void {
  if (prepareAttempted) {
    return;
  }
  prepareAttempted = true;

  try {
    const paths = getEmbeddedSignalRuntimePaths();
    validateRuntime(paths);
    installGetUserIdHandler();

    // esbuild defines process.env.NODE_ENV as a compile-time constant. Use
    // Reflect for the real Electron process environment without assigning to
    // the substituted expression and without producing a misleading warning.
    if (!process.env.NODE_ENV) {
      Reflect.set(process.env, 'NODE_ENV', 'production');
    }
    Reflect.set(process.env, 'SIGNAL_STANDALONE', '0');
    Reflect.set(process.env, 'NODE_CONFIG_DIR', join(paths.root, 'config'));
    Reflect.set(process.env, 'MACTRANSLATE_SIGNAL_RUNTIME', paths.root);

    const runtimeRequire = createRequire(paths.mainEntry);
    runtimeRequire(paths.mainEntry);
    debug(
      `Embedded Signal ${paths.version ?? 'unknown'} main bundle registered`,
    );
  } catch (error) {
    prepareError =
      error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
    debug('Embedded Signal preparation failed', prepareError);
  }
}

export function embeddedSignalPreparationError(): Error | null {
  return prepareError;
}

function isEngineReady(): boolean {
  const api = globals();
  return (
    api.__mactranslateSignalMainReady === true &&
    typeof api.registerProtocolFor === 'function' &&
    typeof api.initSql === 'function' &&
    typeof api.parseSignalRoute === 'function' &&
    typeof api.handleSignalRoute === 'function'
  );
}

export async function waitForEmbeddedSignalEngine(
  timeoutMs = 45_000,
): Promise<EmbeddedSignalGlobals> {
  if (prepareError) {
    throw prepareError;
  }
  if (!prepareAttempted) {
    throw new Error(
      'Signal engine was not prepared before Electron app.ready.',
    );
  }

  if (!app.isReady()) {
    await app.whenReady();
  }

  const deadline = Date.now() + timeoutMs;
  while (!isEngineReady()) {
    if (prepareError) {
      throw prepareError;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        'Embedded Signal main process did not finish app.ready initialization and SQL IPC registration before timeout.',
      );
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return globals();
}
