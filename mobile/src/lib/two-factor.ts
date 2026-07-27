export type SecondFactorMode = 'authenticator' | 'recovery';

type Translate = (key: string, params?: Record<string, string | number>) => string;

const RECOVERY_CODE_PATTERN = /^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/i;

export function normalizeSecondFactorInput(value: string) {
  return value.trim().toLowerCase();
}

export function validateSecondFactorInput(t: Translate, mode: SecondFactorMode, value: string) {
  const normalized = normalizeSecondFactorInput(value);
  if (mode === 'authenticator') {
    return /^\d{6}$/.test(normalized) ? null : t('auth.invalidAuthCode');
  }
  return RECOVERY_CODE_PATTERN.test(normalized) ? null : t('auth.invalidRecoveryCode');
}
