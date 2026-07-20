export type SecondFactorMode = 'authenticator' | 'recovery';

const RECOVERY_CODE_PATTERN = /^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/i;

export function normalizeSecondFactorInput(value: string) {
  return value.trim().toLowerCase();
}

export function validateSecondFactorInput(mode: SecondFactorMode, value: string) {
  const normalized = normalizeSecondFactorInput(value);
  if (mode === 'authenticator') {
    return /^\d{6}$/.test(normalized)
      ? null
      : 'Enter the 6-digit code from your authenticator app';
  }
  return RECOVERY_CODE_PATTERN.test(normalized)
    ? null
    : 'Enter a recovery code in the format xxxx-xxxx-xxxx-xxxx';
}
