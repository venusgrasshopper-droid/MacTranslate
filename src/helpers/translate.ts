import {
  type GoogleTranslation,
  googleTranslateWithAlternatives,
  type TranslationItem,
  type TranslationResponse,
  translateWithGoogle,
} from './google-translate';
import { translateWithMacOS } from './macos-translation-native';

// Google Translate first. When it fails (rate limited, unreachable), Apple's
// on-device translation takes over, and Google is left alone for a while so a
// rate limit is not prolonged.
const GOOGLE_COOLDOWN_MS = 10 * 60_000;
let googleBlockedUntil = 0;

export const googleAvailable = (): boolean => Date.now() >= googleBlockedUntil;

const markGoogleFailed = () => {
  googleBlockedUntil = Date.now() + GOOGLE_COOLDOWN_MS;
};

export const translateItems = async (
  items: TranslationItem[],
): Promise<TranslationResponse> => {
  if (googleAvailable()) {
    const google = await translateWithGoogle(items);
    const failed = google.results.filter(
      result => result.status === 'translationError',
    );
    if (failed.length === 0) return google;
    markGoogleFailed();
    const apple = await translateWithMacOS(
      failed.map(result => ({
        id: result.id,
        text: items.find(item => item.id === result.id)?.text ?? '',
      })),
    );
    const byId = new Map(apple.results.map(result => [result.id, result]));
    return {
      ok: true,
      engine: 'Google Translate + macOS Translation',
      results: google.results.map(result => byId.get(result.id) ?? result),
    };
  }
  return translateWithMacOS(items);
};

// Composer: Google with sentence alternatives, or null when Google is not usable.
export const translateWithAlternatives = async (
  text: string,
): Promise<GoogleTranslation | null> => {
  if (!googleAvailable()) return null;
  const google = await googleTranslateWithAlternatives(text);
  if (google.ok) return google;
  markGoogleFailed();
  return null;
};
