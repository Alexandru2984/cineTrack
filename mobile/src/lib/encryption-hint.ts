import type { EncryptionStatus } from '@/store/encryption';

/** Which line describes the encryption state, or none.
 *
 *  Lives in lib/ rather than beside the card so it can be imported without
 *  pulling in React Native and the icon package. Component tests do not work on
 *  this client — @testing-library/react-native 14 returns an empty render
 *  result under React 19 and React Native 0.86 — so keeping the decision
 *  separable is what makes it testable at all.
 *
 *  'loading' is momentary and 'unavailable' is explained by the gate itself, in
 *  more detail than a subtitle has room for. Both return null rather than
 *  inventing something to say.
 */
export function encryptionHintKey(status: EncryptionStatus): string | null {
  if (status === 'ready') return 'encryption.settingsReady';
  if (status === 'locked') return 'encryption.settingsLocked';
  if (status === 'absent') return 'encryption.settingsAbsent';
  return null;
}
