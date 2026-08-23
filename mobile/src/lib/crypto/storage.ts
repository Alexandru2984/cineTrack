/** Local storage for the identity keys that decrypt this account's messages.
 *
 *  The native counterpart of the web client's IndexedDB store, and deliberately
 *  not the same file: keys belong in the keychain here, and pretending the two
 *  platforms store things the same way would be a fiction to work around rather
 *  than a shared implementation.
 *
 *  `expo-secure-store` puts values in the iOS keychain and the Android
 *  EncryptedSharedPreferences, both backed by hardware where the device has it.
 *  That is a genuinely stronger guarantee than the browser's — the keys are not
 *  readable by other apps, and on a locked device not readable at all — so the
 *  trade the web client has to make is not one that has to be made here.
 *
 *  Keys are scoped by user id, so two accounts on one phone cannot read each
 *  other's messages. */
import * as SecureStore from 'expo-secure-store';

import { fromHex, toHex, type IdentityKeyPair } from '@/lib/crypto/core';

/** SecureStore keys allow only word characters, dots and dashes, and a UUID
 *  already satisfies that. Prefixed so an entry is recognisable in a keychain
 *  dump rather than looking like a stray identifier. */
function entryKey(userId: string): string {
  return `vazute.e2ee.${userId.replace(/[^\w.-]/g, '')}`;
}

interface StoredIdentity {
  exchangePublicKey: string;
  exchangePrivateKey: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  /** The fingerprint published alongside these keys, so a mismatch with the
   *  directory — a key replaced elsewhere — is detectable without a network
   *  round trip. */
  fingerprint: string;
}

export async function storageIsAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function loadIdentity(
  userId: string,
): Promise<{ identity: IdentityKeyPair; fingerprint: string } | null> {
  try {
    const raw = await SecureStore.getItemAsync(entryKey(userId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredIdentity;
    return {
      identity: {
        exchangePublicKey: fromHex(stored.exchangePublicKey),
        exchangePrivateKey: fromHex(stored.exchangePrivateKey),
        signingPublicKey: fromHex(stored.signingPublicKey),
        signingPrivateKey: fromHex(stored.signingPrivateKey),
      },
      fingerprint: stored.fingerprint,
    };
  } catch {
    // A keychain that will not open, or an entry this build cannot parse, is
    // indistinguishable to the caller from having nothing stored.
    return null;
  }
}

export async function saveIdentity(
  userId: string,
  identity: IdentityKeyPair,
  fingerprint: string,
): Promise<void> {
  const stored: StoredIdentity = {
    exchangePublicKey: toHex(identity.exchangePublicKey),
    exchangePrivateKey: toHex(identity.exchangePrivateKey),
    signingPublicKey: toHex(identity.signingPublicKey),
    signingPrivateKey: toHex(identity.signingPrivateKey),
    fingerprint,
  };
  await SecureStore.setItemAsync(entryKey(userId), JSON.stringify(stored), {
    // Available after the first unlock rather than only while unlocked: the app
    // refreshes in the background, and a key that cannot be read then would
    // make notifications about a message arrive without the message.
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/** Forget this account's keys on this device. */
export async function forgetIdentity(userId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(entryKey(userId));
  } catch {
    // Throwing here would block sign-out, which is worse than a key that
    // outlives the session.
  }
}
