// Translation layer. Screens call `useT()` (src/hooks/use-t.ts); pure engines (reports, CSV) call `translate(lang, …)`.
// EN + DE now; the other 13 locales of SPEC §3.6 come in P6 with the same keys (parity test).
import { getLocales } from 'expo-localization';

import { DEFAULT_LANGUAGE, LANGUAGES, translate, type Language, type Translator } from './translate';

export { DEFAULT_LANGUAGE, LANGUAGES, defaultLocale, formatNumber, messages, translate } from './translate';
export type { Language, MessageKey, Translator } from './translate';
/** What the user picked in Settings: a language, or follow the device. */
export type LanguagePreference = 'system' | Language;

/** 'de', 'de-DE' and 'de_AT' all mean German; anything unsupported falls back to English. */
export function resolveLanguage(preference: LanguagePreference, deviceTag: string | undefined): Language {
  if (preference !== 'system') return preference;
  const primary = deviceTag?.split(/[-_]/)[0]?.toLowerCase();
  return LANGUAGES.find((l) => l === primary) ?? DEFAULT_LANGUAGE;
}

/** Device language tag via expo-localization; undefined when unavailable (tests, web). */
export function deviceLanguageTag(): string | undefined {
  try {
    return getLocales()[0]?.languageTag;
  } catch {
    return undefined;
  }
}

let current: Language = resolveLanguage('system', deviceLanguageTag());
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  listeners.forEach((l) => l());
}

export function applyLanguagePreference(preference: LanguagePreference): void {
  setLanguage(resolveLanguage(preference, deviceLanguageTag()));
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const translators = new Map<Language, Translator>();

/** One translator per language: same identity for the same language, a different function for another one. */
export function makeT(language: Language): Translator {
  let t = translators.get(language);
  if (!t) {
    t = (key, params) => translate(language, key, params);
    translators.set(language, t);
  }
  return t;
}
