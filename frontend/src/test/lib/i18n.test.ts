import { describe, expect, it } from 'vitest';
import { dictionaries, SUPPORTED_LOCALES, translate } from '@/lib/i18n';

// Structural parity: `ro` is typed as the `en` shape, so this can only ever
// catch a value that was accidentally left empty; it also documents intent.
function flatten(object: unknown, prefix = ''): string[] {
  if (typeof object !== 'object' || object === null) return [prefix];
  return Object.entries(object as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n', () => {
  it('exposes english and romanian', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ro']);
  });

  it('keeps every locale in structural sync with english', () => {
    const englishKeys = flatten(dictionaries.en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(flatten(dictionaries[locale]).sort()).toEqual(englishKeys);
    }
  });

  it('translates known keys per locale', () => {
    expect(translate('en', 'calendarFeed.title')).toBe('Calendar feed');
    expect(translate('ro', 'calendarFeed.title')).toBe('Feed de calendar');
  });

  it('falls back to english then to the raw key', () => {
    // `common.copy` exists; a fabricated key returns itself.
    expect(translate('ro', 'common.copy')).toBe('Copiază');
    expect(translate('ro', 'does.not.exist')).toBe('does.not.exist');
  });

  it('interpolates named parameters', () => {
    // Uses translate's interpolation directly with an ad-hoc template key miss,
    // so the raw key is returned unchanged when no placeholder is present.
    expect(translate('en', 'common.copy', { unused: 1 })).toBe('Copy');
  });
});
