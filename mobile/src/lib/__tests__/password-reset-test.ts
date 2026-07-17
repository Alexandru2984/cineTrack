import { extractPasswordResetToken } from '@/lib/password-reset';

const token = 'a1'.repeat(64);

describe('password reset deep links', () => {
  it('extracts a valid token from an HTTPS fragment', () => {
    expect(extractPasswordResetToken(undefined, `token=${token}`)).toBe(token);
    expect(extractPasswordResetToken(undefined, `#token=${token}`)).toBe(token);
  });

  it('keeps query-token compatibility for custom-scheme and local links', () => {
    expect(extractPasswordResetToken([token], undefined)).toBe(token);
  });

  it.each([
    ['too short', 'a'.repeat(127)],
    ['not hexadecimal', 'z'.repeat(128)],
    ['empty', ''],
  ])('rejects a %s token', (_label, invalidToken) => {
    expect(extractPasswordResetToken(invalidToken, undefined)).toBeNull();
  });
});
