import {
  normalizeSecondFactorInput,
  validateSecondFactorInput,
} from '@/lib/two-factor';

describe('second-factor input', () => {
  it('accepts only six decimal digits in authenticator mode', () => {
    expect(validateSecondFactorInput('authenticator', ' 123456 ')).toBeNull();
    expect(validateSecondFactorInput('authenticator', '12345')).toMatch(/6-digit/);
    expect(validateSecondFactorInput('authenticator', '12a456')).toMatch(/6-digit/);
    expect(validateSecondFactorInput('authenticator', 'aaaa-bbbb-cccc-dddd')).toMatch(/6-digit/);
  });

  it('accepts the generated recovery-code format independently of letter case', () => {
    expect(validateSecondFactorInput('recovery', ' ABCD-1234-EF56-7890 ')).toBeNull();
    expect(validateSecondFactorInput('recovery', '123456')).toMatch(/recovery code/);
    expect(validateSecondFactorInput('recovery', 'abcd-efgh-ijkl-mnop')).toMatch(/recovery code/);
  });

  it('normalizes submitted values without changing separators', () => {
    expect(normalizeSecondFactorInput(' ABCD-1234-EF56-7890 ')).toBe(
      'abcd-1234-ef56-7890',
    );
  });
});
