import { readFragmentOneTimeToken, scrubOneTimeTokenUrl } from '@/lib/oneTimeToken';

const token = 'a1'.repeat(64);

describe('web one-time tokens', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('accepts a generated token from the URL fragment', () => {
    expect(readFragmentOneTimeToken(`#token=${token}`)).toBe(token);
  });

  it.each([
    ['missing', ''],
    ['too short', `#token=${'a'.repeat(127)}`],
    ['not hexadecimal', `#token=${'z'.repeat(128)}`],
  ])('rejects a %s fragment token', (_label, fragment) => {
    expect(readFragmentOneTimeToken(fragment)).toBe('');
  });

  it('does not accept a token from the query string', () => {
    window.history.replaceState(null, '', `/reset-password?token=${token}&source=email`);

    expect(readFragmentOneTimeToken(window.location.hash)).toBe('');

    scrubOneTimeTokenUrl();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/reset-password?source=email',
    );
  });

  it('removes the fragment immediately after capture', () => {
    window.history.replaceState(null, '', `/verify-email?source=email#token=${token}`);

    const captured = readFragmentOneTimeToken(window.location.hash);
    scrubOneTimeTokenUrl();

    expect(captured).toBe(token);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/verify-email?source=email',
    );
  });
});
