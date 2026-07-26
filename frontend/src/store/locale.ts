import { create } from 'zustand';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

const STORAGE_KEY = 'vazute-locale';

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
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => {
  const initial = getInitialLocale();
  applyLocale(initial);
  return {
    locale: initial,
    setLocale: (locale) => {
      applyLocale(locale);
      set({ locale });
    },
  };
});
