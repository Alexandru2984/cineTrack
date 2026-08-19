/** The identity keys in use for this session.
 *
 *  Deliberately not persisted by Zustand: the keys live in IndexedDB, scoped by
 *  user id, and this store is the loaded copy. Persisting it again would put
 *  private keys in localStorage as a side effect, which is the one place they
 *  should not be. */
import { create } from 'zustand';

import type { IdentityKeyPair } from '@/lib/crypto/core';
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
  /** This browser cannot store keys, so encryption cannot be offered here. */
  | 'unavailable';

interface EncryptionState {
  status: EncryptionStatus;
  identity: IdentityKeyPair | null;
  fingerprint: string | null;
  setIdentity: (identity: IdentityKeyPair, fingerprint: string) => void;
  setStatus: (status: EncryptionStatus) => void;
  /** Drop the keys from memory and from this device. Called on sign-out:
   *  leaving them behind would let whoever signs in next read the previous
   *  account's messages. */
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
    if (userId) await forgetIdentity(userId);
  },
}));
