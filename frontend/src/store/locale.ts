import { create } from 'zustand';
import { SUPPORTED_LOCALES, loadLocale, type Locale } from '@/lib/i18n';

const STORAGE_KEY = 'vazute-locale';

/** The locale to start in, decided before anything renders. */
export function initialLocale(): Locale {
  return getInitialLocale();
}

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
      return stored as Locale;
    }
  } catch {
    // Storage can be unavailable in hardened or sandboxed browser contexts.
  }
  const navigatorLanguage = typeof navigator === 'undefined' ? '' : navigator.language.toLowerCase();
  return navigatorLanguage.startsWith('ro') ? 'ro' : 'en';
}

function applyLocale(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore: persistence is best-effort.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

interface LocaleState {
  locale: Locale;
  /** Resolves once the new dictionary is loaded and the switch has happened.
   *  Returning the promise rather than firing and forgetting is what lets a
   *  caller — or a test — know when the interface is actually in the new
   *  language. */
  setLocale: (locale: Locale) => Promise<void>;
}

export const useLocaleStore = create<LocaleState>((set) => {
  const initial = getInitialLocale();
  applyLocale(initial);
  return {
    locale: initial,
    setLocale: (locale) => {
      applyLocale(locale);
      // Switch only once the new dictionary is in hand. Setting the locale
      // first would render every string as its raw key for as long as the
      // fetch takes — brief, and exactly the kind of flicker people report as
      // "the app broke for a second".
      return loadLocale(locale).then(() => set({ locale }));
    },
  };
});
