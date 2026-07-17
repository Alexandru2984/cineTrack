import { describe, expect, it } from 'vitest';
import { loginPathFor, safeReturnTo } from '@/lib/navigation';

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
