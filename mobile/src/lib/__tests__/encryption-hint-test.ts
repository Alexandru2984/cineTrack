import { encryptionHintKey } from '@/lib/encryption-hint';

/** Why the card exists at all.
 *
 *  Encryption was offered in exactly one place on this client: inside a thread
 *  with somebody who could already be messaged. Direct messages need a mutual
 *  follow, so reaching it needed a friend, an open conversation and a reason to
 *  look — and across eleven accounts nobody had ever set it up.
 *
 *  Only the decision is asserted here, not the rendering. Component tests do
 *  not currently work on this client: @testing-library/react-native 14 returns
 *  an empty render result under React 19 and React Native 0.86, which is why
 *  the app has none. The web card is covered by real render tests, and the two
 *  make the same choices.
 */
describe('encryptionHintKey', () => {
  it('describes each state a member can actually be in', () => {
    expect(encryptionHintKey('absent')).toBe('encryption.settingsAbsent');
    expect(encryptionHintKey('locked')).toBe('encryption.settingsLocked');
    expect(encryptionHintKey('ready')).toBe('encryption.settingsReady');
  });

  it('says nothing while the answer is still unknown', () => {
    // A subtitle that flickers in and out during a momentary state is worse
    // than no subtitle.
    expect(encryptionHintKey('loading')).toBeNull();
  });

  it('leaves an unusable device to the gate, which has room to explain it', () => {
    expect(encryptionHintKey('unavailable')).toBeNull();
  });
});
