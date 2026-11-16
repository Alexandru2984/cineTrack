export type SecondFactorMode = 'authenticator' | 'recovery';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Sixteen characters in four groups of four: base32 (`a-z`, `2-7`) for codes
 *  issued from 2026-11-16, lowercase hex for the ones before. The server
 *  accepts both, so this does too. */
const RECOVERY_CODE_PATTERN = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/;

/** Lower-cased and trimmed; a recovery code typed without its dashes, or with
 *  spaces, is regrouped the way the server stores it. */
export function normalizeSecondFactorInput(value: string) {
  const trimmed = value.trim().toLowerCase();
  const compact = trimmed.replace(/[\s-]/g, '');
  return /^[a-z0-9]{16}$/.test(compact) ? compact.replace(/(.{4})(?=.)/g, '$1-') : trimmed;
}

export function validateSecondFactorInput(t: Translate, mode: SecondFactorMode, value: string) {
  const normalized = normalizeSecondFactorInput(value);
  if (mode === 'authenticator') {
    return /^\d{6}$/.test(normalized) ? null : t('auth.invalidAuthCode');
  }
  return RECOVERY_CODE_PATTERN.test(normalized) ? null : t('auth.invalidRecoveryCode');
}
