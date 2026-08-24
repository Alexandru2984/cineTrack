import type { Dictionary } from './en';

export type { Dictionary } from './en';
export type Locale = 'en' | 'ro';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ro'];

/** Dictionaries that have been loaded, keyed by locale.
 *
 *  Both used to be imported statically, so every visitor downloaded both — some
 *  twenty kilobytes gzipped of a language they cannot read, on the initial
 *  route, on every visit. Loading one is worth the small amount of machinery
 *  below. */
const loaded = new Map<Locale, Dictionary>();
const inFlight = new Map<Locale, Promise<void>>();

const loaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
  en: () => import('./en'),
  ro: () => import('./ro'),
};

/** Load a locale's dictionary, at most once per locale.
 *
 *  Awaited before the app renders, so `translate` stays synchronous everywhere
 *  else. The alternative is making every call site async for a value that is
 *  present within a frame. */
export function loadLocale(locale: Locale): Promise<void> {
  if (loaded.has(locale)) return Promise.resolve();
  const existing = inFlight.get(locale);
  if (existing) return existing;

  const pending = loaders[locale]()
    .then((module) => {
      const dictionary = (module[locale] ?? module.default) as Dictionary | undefined;
      if (dictionary) loaded.set(locale, dictionary);
    })
    .finally(() => {
      inFlight.delete(locale);
    });
  inFlight.set(locale, pending);
  return pending;
}

/** Exposed for the structural-parity test, which needs both dictionaries and is
 *  the reason shipping one of them is safe. */
export async function loadAllLocales(): Promise<Record<Locale, Dictionary>> {
  await Promise.all(SUPPORTED_LOCALES.map(loadLocale));
  return Object.fromEntries(loaded) as Record<Locale, Dictionary>;
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
 * Resolve a dot-path translation key for a locale.
 *
 * Falls back to English when English is loaded, then to the raw key. Only one
 * locale is loaded now, so that fallback usually has nothing to offer — which
 * is safe because the i18n test asserts every locale carries every key English
 * does. That test is what makes shipping one dictionary reasonable; without it
 * a missing Romanian key would surface as `messages.title` rather than as
 * English text.
 *
 * `{name}` placeholders are interpolated from `params`.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const value = lookup(loaded.get(locale), key) ?? lookup(loaded.get('en'), key) ?? key;
  return params ? interpolate(value, params) : value;
}
