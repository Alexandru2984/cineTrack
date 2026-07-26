import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { SUPPORTED_LOCALES, localeTag, type Locale } from '@/lib/i18n';
import { setFormatLocaleTag } from '@/lib/format';

const STORAGE_KEY = 'vazute.locale';

function deviceLocale(): Locale {
  const code = getLocales()[0]?.languageCode?.toLowerCase() ?? 'en';
  return code === 'ro' ? 'ro' : 'en';
}

/** Keeps the plain `Intl` formatters in `lib/format` on the active locale. */
function applyFormatLocale(locale: Locale) {
  setFormatLocaleTag(localeTag(locale));
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Load a persisted override, if any. Called once at startup. */
  hydrate: () => Promise<void>;
}

export const useLocaleStore = create<LocaleState>((set) => {
  // Start from the device language; a saved override is applied by hydrate().
  const initialLocale = deviceLocale();
  applyFormatLocale(initialLocale);
  return {
    locale: initialLocale,
    setLocale: (locale) => {
      // Update the formatters before notifying subscribers so any component
      // re-rendering off this change reads dates in the new locale immediately.
      applyFormatLocale(locale);
      set({ locale });
      void SecureStore.setItemAsync(STORAGE_KEY, locale).catch(() => undefined);
    },
    hydrate: async () => {
      try {
        const stored = await SecureStore.getItemAsync(STORAGE_KEY);
        if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
          applyFormatLocale(stored as Locale);
          set({ locale: stored as Locale });
        }
      } catch {
        // Persistence is best-effort; fall back to the device language.
      }
    },
  };
});
