/** Setting up, restoring, and using this account's encryption identity.
 *
 *  Everything the server sees here is opaque to it: wrapped key material and
 *  the parameters needed to reproduce the wrapping key, never the key. */
import { getRandomBytes } from 'expo-crypto';

import { apiRequest } from '@/lib/api';
import {
  DEFAULT_KDF_COST,
  SALT_BYTES,
  deriveWrappingKey,
  fingerprint as computeFingerprint,
  fromHex,
  generateIdentity,
  generateRecoveryCode,
  toHex,
  unwrapIdentity,
  wrapIdentity,
  type IdentityKeyPair,
  type KdfCost,
} from '@/lib/crypto/core';
import { loadIdentity, saveIdentity } from '@/lib/crypto/storage';
import type { KdfParameters, KeyBackup, KeyStatus, PeerPublicKeys } from '@/types';

function randomSalt(saltBytes: number): Uint8Array {
  return getRandomBytes(saltBytes);
}

function costFromApi(kdf: KdfParameters): KdfCost {
  return {
    memoryKib: kdf.memory_kib,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
  };
}

export interface SetupResult {
  identity: IdentityKeyPair;
  fingerprint: string;
  /** Shown once and never recoverable afterwards. It is the only thing that
   *  opens the stored copy of the private key, so a user who loses it loses
   *  their message history — which is the cost of the server not being able to
   *  read it. */
  recoveryCode: string;
}

/** Create an identity, publish its public half, and store one wrapped copy of
 *  its private half.
 *
 *  One copy, under the recovery code. There used to be a second under a key
 *  derived from the account password, which made losing the password
 *  survivable — but the password reaches the server on every sign-in, so that
 *  copy was one the server could open, and the promise that it cannot read
 *  messages was not true of the protocol. The recovery code is generated here
 *  and never leaves the device. */
export async function setupIdentity(userId: string): Promise<SetupResult> {
  const identity = generateIdentity();
  const recoveryCode = generateRecoveryCode();
  const fingerprint = computeFingerprint(identity.exchangePublicKey, identity.signingPublicKey);

  const recoverySalt = randomSalt(SALT_BYTES);

  await apiRequest('/encryption/keys', {
    method: 'PUT',
    body: {
      exchange_public_key: toHex(identity.exchangePublicKey),
      signing_public_key: toHex(identity.signingPublicKey),
      key_fingerprint: fingerprint,
      recovery_wrapped_key: toHex(
        wrapIdentity(identity, deriveWrappingKey(recoveryCode, recoverySalt, DEFAULT_KDF_COST)),
      ),
      recovery_kdf_salt: toHex(recoverySalt),
      recovery_kdf: {
        memory_kib: DEFAULT_KDF_COST.memoryKib,
        iterations: DEFAULT_KDF_COST.iterations,
        parallelism: DEFAULT_KDF_COST.parallelism,
      },
    },
  });

  await saveIdentity(userId, identity, fingerprint);
  return { identity, fingerprint, recoveryCode };
}

/** This account's stored backup, as the server holds it. */
export async function fetchKeyBackup(): Promise<KeyBackup> {
  return apiRequest<KeyBackup>('/encryption/keys/backup');
}

/** Whether the server still holds a copy of this identity that the account
 *  password opens.
 *
 *  True only for accounts set up before that copy was removed and whose owner
 *  has not yet saved a fresh recovery code. It is what both the restore screen
 *  and the settings prompt branch on, and false for every account created
 *  since. A backup that does not exist at all counts as false: there is nothing
 *  to upgrade. */
export async function passwordCopyStillExists(): Promise<boolean> {
  try {
    return Boolean((await fetchKeyBackup()).password_wrapped_key);
  } catch {
    return false;
  }
}

/** Replace the stored copy with one sealed under a brand-new recovery code, and
 *  drop the copy the password opens.
 *
 *  This is the upgrade path for accounts that predate the removal, and the
 *  ordinary way to rotate a code that was written down somewhere it should not
 *  have been. The old code stops working the moment this returns, so the caller
 *  has to show the new one before anything else.
 *
 *  Needs the account password because it destroys the only copy there is: a
 *  stolen access token could otherwise make an account unrestorable without
 *  ever holding its identity. */
export async function rotateRecoveryCode(
  identity: IdentityKeyPair,
  currentPassword: string,
  totpCode?: string,
): Promise<string> {
  const recoveryCode = generateRecoveryCode();
  const salt = randomSalt(SALT_BYTES);

  await apiRequest('/encryption/keys/backup', {
    method: 'PUT',
    body: {
      recovery_wrapped_key: toHex(
        wrapIdentity(identity, deriveWrappingKey(recoveryCode, salt, DEFAULT_KDF_COST)),
      ),
      recovery_kdf_salt: toHex(salt),
      recovery_kdf: {
        memory_kib: DEFAULT_KDF_COST.memoryKib,
        iterations: DEFAULT_KDF_COST.iterations,
        parallelism: DEFAULT_KDF_COST.parallelism,
      },
      current_password: currentPassword,
      ...(totpCode ? { totp_code: totpCode } : {}),
    },
  });

  return recoveryCode;
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

/** Asked to restore with the password on an account that has no password copy.
 *
 *  Separate from a wrong password: nothing the user types can succeed, so
 *  telling them to check it and try again would be a lie. */
export class PasswordRestoreUnavailableError extends Error {
  constructor() {
    super('password-restore-unavailable');
    this.name = 'PasswordRestoreUnavailableError';
  }
}

/** Recover the identity on a device that does not have it.
 *
 *  From the recovery code, or — for accounts that predate its removal and have
 *  not yet completed the upgrade — from the password. */
export async function restoreIdentity(
  userId: string,
  secret: string,
  kind: 'password' | 'recovery',
): Promise<{ identity: IdentityKeyPair; fingerprint: string }> {
  const [backup, status] = await Promise.all([
    fetchKeyBackup(),
    apiRequest<KeyStatus>('/encryption/keys'),
  ]);

  // Each copy carries its own cost now. The recovery half used to borrow the
  // password half's parameters, which cannot survive the password half going
  // away — and reading them from the wrong copy would derive a key that opens
  // nothing, indistinguishable here from a wrong secret.
  let wrapped: string;
  let salt: string;
  let cost: KdfParameters;
  if (kind === 'password') {
    if (!backup.password_wrapped_key || !backup.password_kdf_salt || !backup.password_kdf) {
      throw new PasswordRestoreUnavailableError();
    }
    wrapped = backup.password_wrapped_key;
    salt = backup.password_kdf_salt;
    cost = backup.password_kdf;
  } else {
    wrapped = backup.recovery_wrapped_key;
    salt = backup.recovery_kdf_salt;
    cost = backup.recovery_kdf;
  }

  const wrappingKey = deriveWrappingKey(secret, fromHex(salt), costFromApi(cost));

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
    return await apiRequest<PeerPublicKeys>(
      `/encryption/keys/${encodeURIComponent(username)}`,
    );
  } catch {
    // A peer with no published keys is the ordinary case during rollout, not an
    // error: the conversation simply stays in plain text.
    return null;
  }
}

export async function loadStoredIdentity(userId: string) {
  return loadIdentity(userId);
}
