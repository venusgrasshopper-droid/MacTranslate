import {
  type GoogleTranslation,
  googleAvailable,
  googleTranslateWithAlternatives,
  type TranslationItem,
  type TranslationResponse,
  translateWithGoogle,
} from './google-translate';
import { translateWithMacOS } from './macos-translation-native';

export { googleAvailable } from './google-translate';

// Google Translate first (its own two entrances back each other up). Whatever
// Google cannot translate goes to Apple's on-device translation.
export const translateItems = async (
  items: TranslationItem[],
): Promise<TranslationResponse> => {
  if (!googleAvailable()) return translateWithMacOS(items);
  const google = await translateWithGoogle(items);
  const failed = google.results.filter(
    result => result.status === 'translationError',
  );
  if (failed.length === 0) return google;
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
};

// Composer: Google with sentence alternatives, or null when that entrance is
// not usable (the composer then translates without choices).
export const translateWithAlternatives = async (
  text: string,
): Promise<GoogleTranslation | null> => {
  const google = await googleTranslateWithAlternatives(text);
  return google.ok ? google : null;
};
