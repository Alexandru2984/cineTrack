import { en } from './en';
import { ro } from './ro';

export type { Dictionary } from './en';
export type Locale = 'en' | 'ro';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ro'];

export const dictionaries = { en, ro } as const;

/** BCP-47 tags used for locale-aware `Intl` date and number formatting. */
const LOCALE_TAGS: Record<Locale, string> = { en: 'en-US', ro: 'ro-RO' };

export function localeTag(locale: Locale): string {
  return LOCALE_TAGS[locale];
}

function lookup(dictionary: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>((accumulator, part) => {
    if (accumulator && typeof accumulator === 'object') {
      return (accumulator as Record<string, unknown>)[part];
    }
    return undefined;
  }, dictionary);
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Resolve a dot-path translation key for a locale, falling back to English and
 * then to the raw key so an untranslated string degrades to readable English.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const value = lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key) ?? key;
  return params ? interpolate(value, params) : value;
}
