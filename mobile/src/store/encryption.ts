/** The identity keys in use for this session.
 *
 *  Deliberately not persisted by Zustand: the keys live in the keychain, scoped
 *  by user id, and this store is the loaded copy. Persisting it again would
 *  write private keys to AsyncStorage as a side effect, which is plain
 *  unencrypted storage and the one place they should not be. */
import { create } from 'zustand';

import type { IdentityKeyPair } from '@/lib/crypto/core';
import { clearDecryptionCache } from '@/lib/crypto/cache';
import { forgetIdentity } from '@/lib/crypto/storage';

export type EncryptionStatus =
  /** Still reading local storage; nothing is known yet. */
  | 'loading'
  /** Keys exist on this device and are usable. */
  | 'ready'
  /** The account has published keys but this device does not hold them. The
   *  user must restore with their password or recovery code. */
  | 'locked'
  /** The account has never set up encryption. */
  | 'absent'
  /** This device cannot store keys, so encryption cannot be offered here. */
  | 'unavailable';

interface EncryptionState {
  status: EncryptionStatus;
  identity: IdentityKeyPair | null;
  fingerprint: string | null;
  setIdentity: (identity: IdentityKeyPair, fingerprint: string) => void;
  setStatus: (status: EncryptionStatus) => void;
  /** Drop the keys from memory, and optionally from this device.
   *
   *  Sign-out passes no user id, so the stored copy survives. That is
   *  deliberate: records are keyed by user id and only ever loaded for the
   *  signed-in account, so another person signing in on the same browser
   *  cannot reach them — while the same person signing back in is not made to
   *  retype a password to read their own history. Deleting the keys is for
   *  when the user asks, which is a different action from signing out. */
  clear: (userId: string | null) => Promise<void>;
}

export const useEncryptionStore = create<EncryptionState>((set) => ({
  status: 'loading',
  identity: null,
  fingerprint: null,
  setIdentity: (identity, fingerprint) => set({ identity, fingerprint, status: 'ready' }),
  setStatus: (status) => set({ status }),
  clear: async (userId) => {
    set({ identity: null, fingerprint: null, status: 'loading' });
    // Plaintext decrypted this session must not outlive it in memory.
    clearDecryptionCache();
    if (userId) await forgetIdentity(userId);
  },
}));
