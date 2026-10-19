import { describe, expect, it } from 'vitest';
import { loginPathFor, publicTitlePath, safeReturnTo } from '@/lib/navigation';

describe('authentication return paths', () => {
  it('preserves an internal path with query and fragment', () => {
    expect(safeReturnTo('/settings?source=deletion#delete-account')).toBe(
      '/settings?source=deletion#delete-account',
    );
    expect(loginPathFor('/settings#delete-account')).toBe(
      '/login?returnTo=%2Fsettings%23delete-account',
    );
  });

  it.each([
    null,
    '',
    'https://attacker.example/path',
    '//attacker.example/path',
    '/\\attacker.example/path',
    '/login?returnTo=/settings',
    `/${'x'.repeat(2_049)}`,
  ])('rejects an unsafe or recursive return path: %s', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });
});

describe('publicTitlePath', () => {
  it('names the public page in the reader’s language', () => {
    expect(publicTitlePath('ro', 'movie', '550')).toBe('/ro/film/550');
    expect(publicTitlePath('ro', 'tv', '1399')).toBe('/ro/serial/1399');
    expect(publicTitlePath('en', 'movie', '550')).toBe('/en/movie/550');
    expect(publicTitlePath('en', 'tv', '1399')).toBe('/en/tv/1399');
  });

  it('treats a missing or unknown type as a film, like the media page', () => {
    expect(publicTitlePath('en', null, '550')).toBe('/en/movie/550');
    expect(publicTitlePath('ro', 'person', '550')).toBe('/ro/film/550');
  });

  it('has no public page for anything but a TMDB id', () => {
    for (const id of [undefined, '', '0', '0550', 'abc', '550abc', '1234567890', '../admin']) {
      expect(publicTitlePath('en', 'movie', id)).toBeNull();
    }
  });
});
