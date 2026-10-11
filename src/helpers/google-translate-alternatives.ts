import { net } from 'electron';

// Google Translate's public web endpoint: besides the translation it returns
// alternative translations per sentence (dt=at) and, for single words,
// synonyms (dt=ss) and dictionary meanings (dt=bd).
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT_MS = 8000;
const CACHE_LIMIT = 500;

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

export interface GoogleWordChoices {
  ok: boolean;
  synonyms: string[];
  meanings: string[];
  message?: string;
}

const translationCache = new Map<string, GoogleTranslation>();
const wordCache = new Map<string, GoogleWordChoices>();

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
  const query = new URLSearchParams({ client: 'gtx', dj: '1', ...params });
  for (const value of dt) query.append('dt', value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await net.fetch(`${ENDPOINT}?${query}`, {
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
    return {
      ok: false,
      sentences: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const googleWordChoices = async (
  word: string,
): Promise<GoogleWordChoices> => {
  const key = word.toLowerCase();
  const cached = wordCache.get(key);
  if (cached) return cached;
  try {
    const data = await request({ sl: 'en', tl: 'zh-CN', q: word }, [
      't',
      'ss',
      'bd',
    ]);
    const synonyms: string[] = [];
    for (const synset of data.synsets ?? []) {
      for (const entry of synset.entry ?? []) {
        for (const synonym of entry.synonym ?? []) {
          if (!synonyms.includes(synonym) && synonym.toLowerCase() !== key) {
            synonyms.push(synonym);
          }
        }
      }
    }
    const meanings: string[] = [];
    for (const entry of data.dict ?? []) {
      for (const term of entry.terms ?? []) {
        if (!meanings.includes(term)) meanings.push(term);
      }
    }
    const result = {
      ok: true,
      synonyms: synonyms.slice(0, 12),
      meanings: meanings.slice(0, 6),
    };
    remember(wordCache, key, result);
    return result;
  } catch (error) {
    return {
      ok: false,
      synonyms: [],
      meanings: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
