import { describe, expect, it } from 'vitest';

import { getApiErrorMessage } from '@/lib/api';

describe('getApiErrorMessage', () => {
  it.each([null, undefined, 'network failed', new Error('private detail')])(
    'falls back for non-Axios input: %s',
    (error) => {
      expect(getApiErrorMessage(error, 'Safe fallback')).toBe('Safe fallback');
    },
  );

  it('returns a bounded API message shape without trusting other response values', () => {
    const apiError = {
      isAxiosError: true,
      response: { data: { message: 'Invalid confirmation token' } },
    };
    expect(getApiErrorMessage(apiError, 'Safe fallback')).toBe('Invalid confirmation token');

    expect(
      getApiErrorMessage(
        { ...apiError, response: { data: { message: { secret: true } } } },
        'Safe fallback',
      ),
    ).toBe('Safe fallback');
  });
});
