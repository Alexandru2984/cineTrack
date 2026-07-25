import { mediaLanguageFromLocales } from '@/lib/locale';

function locale(
  languageTag: string,
  languageCode: string | null,
  languageRegionCode: string | null,
) {
  return { languageTag, languageCode, languageRegionCode };
}

describe('mobile media locale', () => {
  it('uses the device preferred language and region', () => {
    expect(
      mediaLanguageFromLocales([locale('ro-RO', 'ro', 'RO')]),
    ).toBe('ro-RO');
  });

  it('keeps valid languages without an alphabetic region', () => {
    expect(
      mediaLanguageFromLocales([locale('es-419', 'es', '419')]),
    ).toBe('es');
  });

  it('recovers the language from complex BCP 47 tags', () => {
    expect(
      mediaLanguageFromLocales([locale('zh-Hans-CN', null, 'CN')]),
    ).toBe('zh-CN');
  });

  it('falls back safely for missing or malformed locales', () => {
    expect(mediaLanguageFromLocales([])).toBe('en-US');
    expect(
      mediaLanguageFromLocales([locale('../../etc/passwd', null, null)]),
    ).toBe('en-US');
  });
});
