import { net } from 'electron';
import translateWebsite from 'google-translate-api-x';

// Free Google Translate, two entrances with separate limits:
// - translate.google.com (what the website itself uses) for normal text;
// - translate.googleapis.com, which also returns sentence alternatives (dt=at).
// An entrance that Google refuses (HTTP 429/403), or that fails 3 times in a
// row, is left alone for 10 minutes; a single slow or failed request is not.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const CHANNEL_COOLDOWN_MS = 10 * 60_000;
const FAILURES_BEFORE_COOLDOWN = 3;
let websiteBlockedUntil = 0;
let apiBlockedUntil = 0;
const failuresInRow = { website: 0, api: 0 };

const httpStatus = (error: unknown): number =>
  Number(
    (error as any)?.status ?? (error as any)?.cause?.response?.status ?? 0,
  );

const entranceWorked = (entrance: 'website' | 'api') => {
  failuresInRow[entrance] = 0;
};

const entranceFailed = (entrance: 'website' | 'api', error: unknown) => {
  const status = httpStatus(error);
  failuresInRow[entrance] += 1;
  if (
    status !== 429 &&
    status !== 403 &&
    failuresInRow[entrance] < FAILURES_BEFORE_COOLDOWN
  ) {
    return;
  }
  failuresInRow[entrance] = 0;
  if (entrance === 'website') {
    websiteBlockedUntil = Date.now() + CHANNEL_COOLDOWN_MS;
  } else {
    apiBlockedUntil = Date.now() + CHANNEL_COOLDOWN_MS;
  }
};

export const googleAvailable = (): boolean =>
  Date.now() >= websiteBlockedUntil || Date.now() >= apiBlockedUntil;
const TIMEOUT_MS = 8000;
const CACHE_LIMIT = 500;
const CONCURRENCY = 4;
// translate.google.com takes several texts in one request.
const BATCH_TEXTS = 20;
const BATCH_CHARS = 5000;
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
    if (!response.ok) {
      throw Object.assign(new Error(`谷歌翻译返回 HTTP ${response.status}`), {
        status: response.status,
      });
    }
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
    entranceWorked('api');
    remember(translationCache, key, result);
    return result;
  } catch (error) {
    entranceFailed('api', error);
    return {
      ok: false,
      sentences: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const languageLabel = (code: string) =>
  code === 'zh-CN' ? 'zh-Hans' : code === 'zh-TW' ? 'zh-Hant' : code;

const direction = (text: string) => {
  const chinese = HAN.test(text);
  // Any Han character means Chinese: auto-detect calls 'send me the 合同' English.
  return {
    chinese,
    from: chinese ? 'zh-CN' : 'auto',
    target: chinese ? 'en' : 'zh-CN',
  };
};

// One text through translate.googleapis.com. Chinese -> English, anything
// with Latin letters -> Chinese; other text is left alone.
const translateTextOnApi = async (
  text: string,
): Promise<Omit<TranslationResult, 'id' | 'originalText'>> => {
  const trimmed = text.trim();
  const cached = textCache.get(trimmed);
  if (cached) return cached;
  const chinese = HAN.test(trimmed);
  if (!chinese && !/[A-Za-z]/.test(trimmed)) {
    return { status: 'unsupportedLanguage', message: '当前只自动处理中英文' };
  }
  const { from, target } = direction(trimmed);
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
      entranceWorked('api');
      remember(textCache, trimmed, result);
      return result;
    } catch (error) {
      entranceFailed('api', error);
    }
  }
  return { status: 'translationError', message: '谷歌翻译暂时不可用' };
};

// One request to translate.google.com for several texts; null where it gave
// no translation.
const translateBatchOnWebsite = async (
  texts: string[],
): Promise<Array<Omit<TranslationResult, 'id' | 'originalText'> | null>> => {
  if (Date.now() < websiteBlockedUntil) return texts.map(() => null);
  try {
    const input = texts.map(text => {
      const { from, target } = direction(text);
      return { text, from, to: target };
    });
    const web: any = await Promise.race([
      (translateWebsite as any)(input, {
        forceBatch: true,
        fallbackBatch: false,
        rejectOnPartialFail: false,
        requestFunction: (url: string, init: RequestInit) =>
          net.fetch(url, init),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
      }),
    ]);
    entranceWorked('website');
    return texts.map((text, index) => {
      const translatedText = String(web?.[index]?.text ?? '').trim();
      if (!translatedText) return null;
      const { chinese, target } = direction(text);
      const result = {
        status: 'ok',
        translatedText,
        sourceLanguage: languageLabel(
          String(
            web[index].from?.language?.iso || (chinese ? 'zh-CN' : 'en'),
          ),
        ),
        targetLanguage: languageLabel(target),
      };
      remember(textCache, text, result);
      return result;
    });
  } catch (error) {
    entranceFailed('website', error);
    return texts.map(() => null);
  }
};

export const translateWithGoogle = async (
  items: TranslationItem[],
): Promise<TranslationResponse> => {
  const results: TranslationResult[] = Array.from({ length: items.length });
  const pending: number[] = [];
  items.forEach((item, index) => {
    const text = item.text.trim();
    const cached = textCache.get(text);
    if (cached) {
      results[index] = { id: item.id, originalText: item.text, ...cached };
    } else if (!HAN.test(text) && !/[A-Za-z]/.test(text)) {
      results[index] = {
        id: item.id,
        originalText: item.text,
        status: 'unsupportedLanguage',
        message: '当前只自动处理中英文',
      };
    } else {
      pending.push(index);
    }
  });

  // translate.google.com first, a group of texts per request.
  let group: number[] = [];
  let groupChars = 0;
  const groups: number[][] = [];
  for (const index of pending) {
    const length = items[index].text.trim().length;
    if (
      group.length > 0 &&
      (group.length >= BATCH_TEXTS || groupChars + length > BATCH_CHARS)
    ) {
      groups.push(group);
      group = [];
      groupChars = 0;
    }
    group.push(index);
    groupChars += length;
  }
  if (group.length > 0) groups.push(group);
  for (const indexes of groups) {
    const web = await translateBatchOnWebsite(
      indexes.map(index => items[index].text.trim()),
    );
    indexes.forEach((index, position) => {
      const result = web[position];
      if (result) {
        results[index] = {
          id: items[index].id,
          originalText: items[index].text,
          ...result,
        };
      }
    });
  }

  // What the website did not translate goes one by one to translate.googleapis.com.
  const rest = pending.filter(index => !results[index]);
  let next = 0;
  const worker = async () => {
    while (next < rest.length) {
      const index = rest[next];
      next += 1;
      const item = items[index];
      results[index] = {
        id: item.id,
        originalText: item.text,
        ...(await translateTextOnApi(item.text)),
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
