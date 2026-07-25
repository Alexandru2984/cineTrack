import type { Locale } from 'expo-localization';

type MediaLocale = Pick<
  Locale,
  'languageCode' | 'languageRegionCode' | 'languageTag'
>;

const LANGUAGE_CODE = /^[A-Za-z]{2}$/;
const REGION_CODE = /^[A-Za-z]{2}$/;

function languageFromTag(languageTag: string) {
  const [language] = languageTag.trim().split(/[-_]/);
  return LANGUAGE_CODE.test(language ?? '') ? language.toLowerCase() : null;
}

export function mediaLanguageFromLocales(
  locales: readonly MediaLocale[],
): string {
  const locale = locales[0];
  if (!locale) return 'en-US';

  const language = LANGUAGE_CODE.test(locale.languageCode ?? '')
    ? locale.languageCode!.toLowerCase()
    : languageFromTag(locale.languageTag);
  if (!language) return 'en-US';

  const region = locale.languageRegionCode?.trim();
  return region && REGION_CODE.test(region)
    ? `${language}-${region.toUpperCase()}`
    : language;
}
