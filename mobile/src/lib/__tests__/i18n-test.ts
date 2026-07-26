import { dictionaries, SUPPORTED_LOCALES, translate } from '@/lib/i18n';

function flatten(object: unknown, prefix = ''): string[] {
  if (typeof object !== 'object' || object === null) return [prefix];
  return Object.entries(object as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('mobile i18n', () => {
  it('supports english and romanian', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ro']);
  });

  it('keeps every locale in structural sync with english', () => {
    const englishKeys = flatten(dictionaries.en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(flatten(dictionaries[locale]).sort()).toEqual(englishKeys);
    }
  });

  it('translates per locale and falls back to the raw key', () => {
    expect(translate('en', 'calendarFeed.title')).toBe('Calendar feed');
    expect(translate('ro', 'calendarFeed.title')).toBe('Feed de calendar');
    expect(translate('ro', 'missing.key')).toBe('missing.key');
  });
});
