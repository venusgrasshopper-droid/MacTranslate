import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

export interface MacOSTranslationItem {
  id: string;
  text: string;
}

export interface MacOSTranslationResult {
  id: string;
  originalText?: string;
  status: string;
  translatedText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  message?: string;
}

export interface MacOSTranslationResponse {
  requestId?: string;
  ok: boolean;
  engine: string;
  results: MacOSTranslationResult[];
  message?: string;
}

type TranslationLane = 'interactive' | 'batch';

const HELPER_NAME = 'mactranslate-translation-helper';
// The helper prints this when the persistent --server mode is unavailable
// (it needs macOS 26); callers then fall back to one-shot runs.
const PERSISTENT_SERVER_UNAVAILABLE =
  'MACTRANSLATE_PERSISTENT_SERVER_REQUIRES_MACOS_26';
const PERSISTENT_REQUEST_TIMEOUT_MS = 30_000;
// Apple's Translation framework (and the helper) need macOS 15, i.e. Darwin 24.
const MIN_DARWIN_MAJOR = 24;
const UNSUPPORTED_SYSTEM_MESSAGE =
  '系统翻译需要 macOS 15 或更新版本，请先升级 macOS';
const systemSupportsTranslation = () =>
  Number.parseInt(release(), 10) >= MIN_DARWIN_MAJOR;
const ONE_SHOT_TIMEOUT_MS = 120_000;

const bundledHelperPath = () =>
  app.isPackaged
    ? join(
        process.resourcesPath,
        'app.asar.unpacked',
        'assets',
        'images',
        'icons',
        HELPER_NAME,
      )
    : join(app.getAppPath(), 'assets', 'images', 'icons', HELPER_NAME);

let executableHelperCache: string | null = null;

// Packaged builds copy the helper out of the app bundle once, so it can be
// spawned from a writable, executable location.
const executableHelperPath = (): string => {
  const bundled = bundledHelperPath();
  if (!app.isPackaged || !existsSync(bundled)) return bundled;
  if (executableHelperCache && existsSync(executableHelperCache)) {
    return executableHelperCache;
  }
  const runtimeDir = join(app.getPath('userData'), 'native-runtime');
  const target = join(runtimeDir, HELPER_NAME);
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(bundled, target);
  chmodSync(target, 0o755);
  executableHelperCache = target;
  return target;
};

const translationCache = new Map<string, Omit<MacOSTranslationResult, 'id'>>();
const TRANSLATION_CACHE_LIMIT = 5000;

const rememberTranslation = (text: string, result: MacOSTranslationResult) => {
  if (
    result.status !== 'ok' &&
    result.status !== 'languagePackRequired' &&
    result.status !== 'unsupportedLanguage' &&
    result.status !== 'unsupportedPair'
  ) {
    return;
  }
  const { id, originalText, ...cached } = result;
  translationCache.delete(text);
  translationCache.set(text, cached);
  if (translationCache.size <= TRANSLATION_CACHE_LIMIT) return;
  const oldest = translationCache.keys().next().value;
  if (oldest) translationCache.delete(oldest);
};

interface PendingRequest {
  resolve: (response: MacOSTranslationResponse) => void;
  timer: NodeJS.Timeout;
}

class TranslationWorker {
  constructor(private readonly lane: TranslationLane) {}

  private child: ChildProcessWithoutNullStreams | null = null;

  private stdoutBuffer = '';

  private sequence = 0;

  private pending = new Map<string, PendingRequest>();

  private permanentlyFallbackToOneShot = false;

  warm(helperPath: string): void {
    if (this.permanentlyFallbackToOneShot) return;
    this.ensureChild(helperPath);
  }

  shouldFallbackToOneShot(): boolean {
    return this.permanentlyFallbackToOneShot;
  }

  request(
    helperPath: string,
    items: MacOSTranslationItem[],
  ): Promise<MacOSTranslationResponse> {
    if (this.permanentlyFallbackToOneShot) {
      return Promise.resolve({
        ok: false,
        engine: 'macOS Translation',
        results: [],
        message: PERSISTENT_SERVER_UNAVAILABLE,
      });
    }
    const child = this.ensureChild(helperPath);
    if (!child || !child.stdin.writable) {
      return Promise.resolve({
        ok: false,
        engine: 'macOS Translation',
        results: [],
        message: 'macOS 系统翻译常驻组件启动失败',
      });
    }
    this.sequence += 1;
    const requestId = `${this.lane}-${process.pid}-${Date.now()}-${this.sequence}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.resetChild();
        resolve({
          requestId,
          ok: false,
          engine: 'macOS Translation',
          results: [],
          message: 'macOS 系统翻译超时',
        });
      }, PERSISTENT_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      try {
        child.stdin.write(`${JSON.stringify({ requestId, items })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.resetChild();
        resolve({
          requestId,
          ok: false,
          engine: 'macOS Translation',
          results: [],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private ensureChild(helperPath: string): ChildProcessWithoutNullStreams | null {
    if (this.child && !this.child.killed && this.child.stdin.writable) {
      return this.child;
    }
    try {
      const child = spawn(helperPath, ['--server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.stdoutBuffer = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => this.consumeStdout(chunk));
      child.on('error', error => this.failAll(error.message));
      child.on('close', () => this.failAll('macOS 系统翻译常驻组件已退出'));
      return child;
    } catch {
      this.child = null;
      return null;
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response: MacOSTranslationResponse;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      const requestId = String(response.requestId ?? '');
      if (response.message === PERSISTENT_SERVER_UNAVAILABLE) {
        this.permanentlyFallbackToOneShot = true;
      }
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(response);
    }
  }

  private failAll(message: string): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    this.child = null;
    this.stdoutBuffer = '';
    for (const [requestId, pending] of entries) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        ok: false,
        engine: 'macOS Translation',
        results: [],
        message,
      });
    }
  }

  private resetChild(): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = '';
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

const workers: Record<TranslationLane, TranslationWorker> = {
  interactive: new TranslationWorker('interactive'),
  batch: new TranslationWorker('batch'),
};

const runTranslationHelperOneShot = async (
  helperPath: string,
  items: MacOSTranslationItem[],
): Promise<MacOSTranslationResponse> =>
  new Promise(resolve => {
    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (response: MacOSTranslationResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        engine: 'macOS Translation',
        results: [],
        message: 'macOS 系统翻译超时',
      });
    }, ONE_SHOT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(timer);
      finish({
        ok: false,
        engine: 'macOS Translation',
        results: [],
        message: error.message,
      });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const lastLine =
          stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        finish(JSON.parse(lastLine));
      } catch {
        finish({
          ok: false,
          engine: 'macOS Translation',
          results: [],
          message: `系统翻译组件返回异常（exit ${code ?? 'unknown'}）：${stderr.trim() || stdout.trim()}`,
        });
      }
    });
    child.stdin.end(JSON.stringify({ items }));
  });

export const warmMacOSTranslationHelper = (): void => {
  if (process.platform !== 'darwin' || !systemSupportsTranslation()) return;
  try {
    const helperPath = executableHelperPath();
    if (!existsSync(helperPath)) return;
    workers.interactive.warm(helperPath);
    workers.batch.warm(helperPath);
  } catch {
    // Warming is best effort; translateWithMacOS reports real failures.
  }
};

export const translateWithMacOS = async (
  items: MacOSTranslationItem[],
  options: { lane?: TranslationLane } = {},
): Promise<MacOSTranslationResponse> => {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      engine: 'macOS Translation',
      results: [],
      message: 'macOS 系统翻译仅支持 macOS',
    };
  }
  if (!systemSupportsTranslation()) {
    return {
      ok: true,
      engine: 'macOS Translation',
      results: items.map(item => ({
        id: item.id,
        originalText: item.text,
        status: 'unsupportedSystem',
        message: UNSUPPORTED_SYSTEM_MESSAGE,
      })),
    };
  }
  let helperPath: string;
  try {
    helperPath = executableHelperPath();
  } catch (error) {
    return {
      ok: false,
      engine: 'macOS Translation',
      results: [],
      message: `系统翻译组件准备失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!existsSync(helperPath)) {
    return {
      ok: false,
      engine: 'macOS Translation',
      results: [],
      message: `系统翻译组件不存在：${helperPath}`,
    };
  }
  if (!items.length) {
    return { ok: true, engine: 'macOS Translation', results: [] };
  }

  const uncached: string[] = [];
  const queued = new Set<string>();
  for (const item of items) {
    const text = item.text.trim();
    if (!text || translationCache.has(text) || queued.has(text)) continue;
    queued.add(text);
    uncached.push(text);
  }

  if (uncached.length) {
    const requestItems = uncached.map((text, index) => ({
      id: `cache-${index}`,
      text,
    }));
    const lane = options.lane ?? 'batch';
    let response = await workers[lane].request(helperPath, requestItems);
    if (
      workers[lane].shouldFallbackToOneShot() ||
      response.message === PERSISTENT_SERVER_UNAVAILABLE
    ) {
      response = await runTranslationHelperOneShot(helperPath, requestItems);
    }
    if (!response.ok) return response;
    const byId = new Map(response.results.map(result => [result.id, result]));
    for (let index = 0; index < uncached.length; index += 1) {
      const result = byId.get(`cache-${index}`);
      if (result) rememberTranslation(uncached[index], result);
    }
  }

  const results = items.map(item => {
    const text = item.text.trim();
    const cached = translationCache.get(text);
    if (!cached) {
      return {
        id: item.id,
        originalText: item.text,
        status: 'translationError',
        message: 'macOS 系统翻译未返回这一条结果',
      };
    }
    return { id: item.id, originalText: item.text, ...cached };
  });
  return { ok: true, engine: 'macOS Translation', results };
};

export interface VoiceTranscription {
  ok: boolean;
  text?: string;
  locale?: string;
  message?: string;
}

const TRANSCRIBE_TIMEOUT_MS = 180_000;

// On-device speech-to-text of a WAV/M4A file (helper --transcribe).
export const transcribeVoiceFile = async (
  file: string,
): Promise<VoiceTranscription> => {
  if (process.platform !== 'darwin' || !systemSupportsTranslation()) {
    return { ok: false, message: '语音转文字需要 macOS 15 或更新版本' };
  }
  const helperPath = executableHelperPath();
  if (!existsSync(helperPath)) {
    return { ok: false, message: `系统翻译组件不存在：${helperPath}` };
  }
  return new Promise(resolve => {
    const child = spawn(helperPath, ['--transcribe', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, message: '语音转文字超时' });
    }, TRANSCRIBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || ''));
      } catch {
        resolve({ ok: false, message: '语音转文字失败' });
      }
    });
  });
};
