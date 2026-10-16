// Pure translation core (no Expo imports) so engines such as report-html and csv can use it in Node and in the app.
import { de } from './de';
import { en, type MessageKey } from './en';

export type { MessageKey };
export type Language = 'en' | 'de';
export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

export const LANGUAGES: readonly Language[] = ['en', 'de'];
export const DEFAULT_LANGUAGE: Language = 'en';
export const messages: Record<Language, Record<MessageKey, string>> = { en, de };

export function translate(language: Language, key: MessageKey, params?: Record<string, string | number>): string {
  const text: string = messages[language][key] ?? messages[DEFAULT_LANGUAGE][key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

/** Number formatting per language for reports and CSV: German uses a decimal comma. */
export function formatNumber(language: Language, value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '–';
  const s = value.toFixed(digits);
  return language === 'de' ? s.replace('.', ',') : s;
}

/** Locale for dates in reports when the caller has no device locale. */
export function defaultLocale(language: Language): string {
  return language === 'de' ? 'de-DE' : 'en-GB';
}
