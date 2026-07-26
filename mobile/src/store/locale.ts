import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

const STORAGE_KEY = 'vazute.locale';

function deviceLocale(): Locale {
  const code = getLocales()[0]?.languageCode?.toLowerCase() ?? 'en';
  return code === 'ro' ? 'ro' : 'en';
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Load a persisted override, if any. Called once at startup. */
  hydrate: () => Promise<void>;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  // Start from the device language; a saved override is applied by hydrate().
  locale: deviceLocale(),
  setLocale: (locale) => {
    set({ locale });
    void SecureStore.setItemAsync(STORAGE_KEY, locale).catch(() => undefined);
  },
  hydrate: async () => {
    try {
      const stored = await SecureStore.getItemAsync(STORAGE_KEY);
      if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
        set({ locale: stored as Locale });
      }
    } catch {
      // Persistence is best-effort; fall back to the device language.
    }
  },
}));
