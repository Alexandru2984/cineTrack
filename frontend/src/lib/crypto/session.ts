/** Setting up, restoring, and using this account's encryption identity.
 *
 *  Everything the server sees here is opaque to it: wrapped key material and
 *  the parameters needed to reproduce the wrapping key, never the key. */
import api from '@/lib/api';
// Loaded on demand. This module is reached from the initial route — the app
// asks on startup whether this device holds keys — while the primitives it uses
// are a third of a megabyte that only setting up or restoring actually needs.
// Type-only imports are erased and cost nothing.
import type { IdentityKeyPair, KdfCost } from '@/lib/crypto/core';
import { loadIdentity, saveIdentity } from '@/lib/crypto/storage';
import type { KeyBackup, KeyStatus, PeerPublicKeys } from '@/types';

const core = () => import('@/lib/crypto/core');

function randomSalt(saltBytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(saltBytes));
}

function costFromApi(kdf: KeyBackup['password_kdf']): KdfCost {
  return {
    memoryKib: kdf.memory_kib,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
  };
}

export interface SetupResult {
  identity: IdentityKeyPair;
  fingerprint: string;
  /** Shown once and never recoverable afterwards. The server stores only what
   *  this code wraps, so a user who loses both it and their password loses
   *  their message history — which is the cost of the server not being able to
   *  read it. */
  recoveryCode: string;
}

/** Create an identity, publish its public half, and store two wrapped copies of
 *  its private half.
 *
 *  Two copies, not one, because the two failure modes are different: a
 *  forgotten password is common and recoverable, and a password change would
 *  otherwise destroy the backup. The recovery code survives both. */
export async function setupIdentity(userId: string, password: string): Promise<SetupResult> {
  const {
    DEFAULT_KDF_COST,
    SALT_BYTES,
    deriveWrappingKey,
    fingerprint: computeFingerprint,
    generateIdentity,
    generateRecoveryCode,
    toHex,
    wrapIdentity,
  } = await core();

  const identity = generateIdentity();
  const recoveryCode = generateRecoveryCode();
  const fingerprint = computeFingerprint(identity.exchangePublicKey, identity.signingPublicKey);

  const passwordSalt = randomSalt(SALT_BYTES);
  const recoverySalt = randomSalt(SALT_BYTES);

  await api.put('/encryption/keys', {
    exchange_public_key: toHex(identity.exchangePublicKey),
    signing_public_key: toHex(identity.signingPublicKey),
    key_fingerprint: fingerprint,
    password_wrapped_key: toHex(
      wrapIdentity(identity, deriveWrappingKey(password, passwordSalt, DEFAULT_KDF_COST)),
    ),
    password_kdf_salt: toHex(passwordSalt),
    password_kdf: {
      memory_kib: DEFAULT_KDF_COST.memoryKib,
      iterations: DEFAULT_KDF_COST.iterations,
      parallelism: DEFAULT_KDF_COST.parallelism,
    },
    recovery_wrapped_key: toHex(
      wrapIdentity(identity, deriveWrappingKey(recoveryCode, recoverySalt, DEFAULT_KDF_COST)),
    ),
    recovery_kdf_salt: toHex(recoverySalt),
  });

  await saveIdentity(userId, identity, fingerprint);
  return { identity, fingerprint, recoveryCode };
}

/** Re-seal the private key under a new password.
 *
 *  Called when the account password changes. Without it the stored copy still
 *  opens under the old password, so the next device to restore is refused with
 *  the password its owner believes is correct — recoverable through the
 *  recovery code, but bewildering, and nothing on that screen suggests reaching
 *  for it.
 *
 *  Only the password copy moves. The recovery copy is sealed under a code this
 *  change has no bearing on, and the identity keys themselves are untouched, so
 *  no peer is told to re-verify a safety number that has not moved.
 *
 *  Returns whether it happened. A device that does not hold the key cannot
 *  re-seal it, and that is a real outcome the caller has to be able to report
 *  rather than an error to swallow. */
export async function rewrapBackup(
  identity: IdentityKeyPair | null,
  newPassword: string,
): Promise<boolean> {
  if (!identity) return false;

  const { DEFAULT_KDF_COST, SALT_BYTES, deriveWrappingKey, toHex, wrapIdentity } = await core();
  const salt = randomSalt(SALT_BYTES);

  await api.put('/encryption/keys/backup', {
    password_wrapped_key: toHex(
      wrapIdentity(identity, deriveWrappingKey(newPassword, salt, DEFAULT_KDF_COST)),
    ),
    password_kdf_salt: toHex(salt),
    password_kdf: {
      memory_kib: DEFAULT_KDF_COST.memoryKib,
      iterations: DEFAULT_KDF_COST.iterations,
      parallelism: DEFAULT_KDF_COST.parallelism,
    },
  });
  return true;
}

export class WrongSecretError extends Error {
  constructor() {
    super('wrong-secret');
    this.name = 'WrongSecretError';
  }
}

export class KeyMismatchError extends Error {
  constructor() {
    super('key-mismatch');
    this.name = 'KeyMismatchError';
  }
}

/** Recover the identity on a device that does not have it, from the password or
 *  the recovery code. */
export async function restoreIdentity(
  userId: string,
  secret: string,
  kind: 'password' | 'recovery',
): Promise<{ identity: IdentityKeyPair; fingerprint: string }> {
  const {
    deriveWrappingKey,
    fingerprint: computeFingerprint,
    fromHex,
    unwrapIdentity,
  } = await core();

  const [backup, status] = await Promise.all([
    api.get<KeyBackup>('/encryption/keys/backup').then((response) => response.data),
    api.get<KeyStatus>('/encryption/keys').then((response) => response.data),
  ]);

  const wrapped =
    kind === 'password' ? backup.password_wrapped_key : backup.recovery_wrapped_key;
  const salt = kind === 'password' ? backup.password_kdf_salt : backup.recovery_kdf_salt;
  // Both copies were wrapped with the same cost. The recovery half has no
  // parameters of its own in the response, and inventing different ones here
  // would make the code unusable on the device that generated it.
  const wrappingKey = deriveWrappingKey(secret, fromHex(salt), costFromApi(backup.password_kdf));

  let identity: IdentityKeyPair;
  try {
    identity = unwrapIdentity(fromHex(wrapped), wrappingKey);
  } catch {
    // AES-GCM refusing to open the wrapper means the derived key was wrong,
    // which means the secret was wrong. There is nothing else it can mean.
    throw new WrongSecretError();
  }

  const fingerprint = computeFingerprint(identity.exchangePublicKey, identity.signingPublicKey);
  if (status.key_fingerprint && status.key_fingerprint !== fingerprint) {
    // The backup opened but describes keys the directory does not list. Either
    // the directory entry was replaced or the backup is stale; continuing would
    // mean sending messages nobody can read.
    throw new KeyMismatchError();
  }

  await saveIdentity(userId, identity, fingerprint);
  return { identity, fingerprint };
}

export async function fetchPeerKeys(username: string): Promise<PeerPublicKeys | null> {
  try {
    const response = await api.get<PeerPublicKeys>(
      `/encryption/keys/${encodeURIComponent(username)}`,
    );
    return response.data;
  } catch {
    // A peer with no published keys is the ordinary case during rollout, not an
    // error: the conversation simply stays in plain text.
    return null;
  }
}

export async function loadStoredIdentity(userId: string) {
  return loadIdentity(userId);
}
