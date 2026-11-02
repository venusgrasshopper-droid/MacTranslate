import { net } from 'electron';
import translateWebsite from 'google-translate-api-x';

// Free Google Translate, two entrances with separate limits:
// - translate.google.com (what the website itself uses) for normal text;
// - translate.googleapis.com, which also returns sentence alternatives (dt=at).
// An entrance that fails is left alone for 10 minutes.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const CHANNEL_COOLDOWN_MS = 10 * 60_000;
let websiteBlockedUntil = 0;
let apiBlockedUntil = 0;

export const googleAvailable = (): boolean =>
  Date.now() >= websiteBlockedUntil || Date.now() >= apiBlockedUntil;
const TIMEOUT_MS = 8000;
const CACHE_LIMIT = 500;
const CONCURRENCY = 4;
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

export interface TranslationItem {
  id: string;
  text: string;
}

export interface TranslationResult {
  id: string;
  originalText?: string;
  status: string;
  translatedText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  message?: string;
}

export interface TranslationResponse {
  ok: boolean;
  engine: string;
  results: TranslationResult[];
  message?: string;
}

export interface GoogleSentence {
  source: string;
  translation: string;
  alternatives: string[];
}

export interface GoogleTranslation {
  ok: boolean;
  sentences: GoogleSentence[];
  message?: string;
}

const translationCache = new Map<string, GoogleTranslation>();
const textCache = new Map<
  string,
  Omit<TranslationResult, 'id' | 'originalText'>
>();

const remember = <T>(cache: Map<string, T>, key: string, value: T) => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
};

const request = async (
  params: Record<string, string>,
  dt: string[],
): Promise<any> => {
  const { q, ...rest } = params;
  const query = new URLSearchParams({ client: 'gtx', dj: '1', ...rest });
  for (const value of dt) query.append('dt', value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // POST keeps long messages out of the URL.
    const response = await net.fetch(`${ENDPOINT}?${query}`, {
      method: 'POST',
      body: new URLSearchParams({ q }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`谷歌翻译返回 HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

export const googleTranslateWithAlternatives = async (
  text: string,
  from = 'zh-CN',
  to = 'en',
): Promise<GoogleTranslation> => {
  if (Date.now() < apiBlockedUntil) {
    return { ok: false, sentences: [], message: '谷歌翻译接口暂时受限' };
  }
  const key = JSON.stringify([from, to, text]);
  const cached = translationCache.get(key);
  if (cached) return cached;
  try {
    const data = await request({ sl: from, tl: to, q: text }, ['t', 'at']);
    const alternatives = new Map<string, string[]>();
    for (const entry of data.alternative_translations ?? []) {
      const options = (entry.alternative ?? [])
        .map((item: any) => String(item.word_postproc ?? '').trim())
        .filter(Boolean);
      alternatives.set(String(entry.src_phrase ?? '').trim(), options);
    }
    const sentences: GoogleSentence[] = (data.sentences ?? [])
      .filter((item: any) => typeof item.trans === 'string')
      .map((item: any) => {
        const source = String(item.orig ?? '');
        const translation = String(item.trans);
        const options = alternatives.get(source.trim()) ?? [];
        return {
          source,
          translation,
          alternatives: [
            ...new Set([translation.trim(), ...options].filter(Boolean)),
          ],
        };
      });
    if (sentences.length === 0) throw new Error('谷歌翻译没有返回结果');
    const result = { ok: true, sentences };
    remember(translationCache, key, result);
    return result;
  } catch (error) {
    apiBlockedUntil = Date.now() + CHANNEL_COOLDOWN_MS;
    return {
      ok: false,
      sentences: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const languageLabel = (code: string) =>
  code === 'zh-CN' ? 'zh-Hans' : code === 'zh-TW' ? 'zh-Hant' : code;

// Chinese -> English, anything with Latin letters -> Chinese; other text is left alone.
const translateText = async (
  text: string,
): Promise<Omit<TranslationResult, 'id' | 'originalText'>> => {
  const trimmed = text.trim();
  const cached = textCache.get(trimmed);
  if (cached) return cached;
  const chinese = HAN.test(trimmed);
  if (!chinese && !/[A-Za-z]/.test(trimmed)) {
    return { status: 'unsupportedLanguage', message: '当前只自动处理中英文' };
  }
  const target = chinese ? 'en' : 'zh-CN';
  // Any Han character means Chinese: auto-detect calls 'send me the 合同' English.
  const from = chinese ? 'zh-CN' : 'auto';
  if (Date.now() >= websiteBlockedUntil) {
    try {
      const web = await Promise.race([
        translateWebsite(trimmed, {
          from,
          to: target,
          forceBatch: true,
          fallbackBatch: false,
          requestFunction: (url: string, init: RequestInit) =>
            net.fetch(url, init),
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        }),
      ]);
      const translatedText = String(web.text ?? '').trim();
      if (!translatedText) throw new Error('谷歌翻译没有返回结果');
      const result = {
        status: 'ok',
        translatedText,
        sourceLanguage: languageLabel(
          String(web.from?.language?.iso || (chinese ? 'zh-CN' : 'en')),
        ),
        targetLanguage: languageLabel(target),
      };
      remember(textCache, trimmed, result);
      return result;
    } catch {
      websiteBlockedUntil = Date.now() + CHANNEL_COOLDOWN_MS;
    }
  }
  if (Date.now() >= apiBlockedUntil) {
    try {
      const data = await request({ sl: from, tl: target, q: trimmed }, ['t']);
      const translatedText = (data.sentences ?? [])
        .map((item: any) => item.trans ?? '')
        .join('')
        .trim();
      if (!translatedText) throw new Error('谷歌翻译没有返回结果');
      const result = {
        status: 'ok',
        translatedText,
        sourceLanguage: languageLabel(
          String(data.src ?? (chinese ? 'zh-CN' : 'en')),
        ),
        targetLanguage: languageLabel(target),
      };
      remember(textCache, trimmed, result);
      return result;
    } catch {
      apiBlockedUntil = Date.now() + CHANNEL_COOLDOWN_MS;
    }
  }
  return { status: 'translationError', message: '谷歌翻译暂时不可用' };
};

export const translateWithGoogle = async (
  items: TranslationItem[],
): Promise<TranslationResponse> => {
  const results: TranslationResult[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      results[index] = {
        id: item.id,
        originalText: item.text,
        ...(await translateText(item.text)),
      };
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { ok: true, engine: 'Google Translate', results };
};

let lastWarmAt = 0;

// Open the TLS connection to Google before the first translation is needed;
// a fresh connection costs ~1 s, a warm one ~0.3 s per request.
export const warmGoogleConnection = (): void => {
  if (Date.now() - lastWarmAt < 30_000) return;
  lastWarmAt = Date.now();
  void net
    .fetch('https://translate.google.com/', { method: 'HEAD' })
    .catch(() => {});
};
