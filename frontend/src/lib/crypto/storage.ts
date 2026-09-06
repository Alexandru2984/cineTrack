/** Local storage for the identity keys that decrypt this account's messages.
 *
 *  # Why IndexedDB, and what it does not protect against
 *
 *  The private keys are stored unwrapped. That is a deliberate trade, and it is
 *  worth being plain about it: script running on this origin can read them.
 *  End-to-end encryption protects messages from the server and from anyone
 *  between here and it; it does not protect them from code already running as
 *  the user.
 *
 *  The alternative — keeping only the wrapped key and deriving the wrapping key
 *  from the password on every page load — would cost an Argon2id derivation and
 *  a password prompt per session. In practice that is not a stricter product,
 *  it is an abandoned one: people turn off the feature that asks them for a
 *  password ten times a day, and a feature nobody enables protects nothing.
 *
 *  IndexedDB rather than localStorage for two reasons that do matter: it stores
 *  the raw bytes without a base64 round trip, and it is not swept up by the
 *  extensions and debugging tools that treat localStorage as a plain-text
 *  scratchpad.
 *
 *  Keys are scoped by user id so that two accounts on one browser cannot read
 *  each other's messages — an ordinary thing on a shared machine. */
import type { IdentityKeyPair } from '@/lib/crypto/core';

const DATABASE_NAME = 'vazute-e2ee';
const DATABASE_VERSION = 1;
const STORE_NAME = 'identities';

interface StoredIdentity {
  userId: string;
  exchangePublicKey: Uint8Array;
  exchangePrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  /** The fingerprint published alongside these keys. Kept so a mismatch with
   *  the directory — a key replaced elsewhere — is detectable without a
   *  network round trip. */
  fingerprint: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'userId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    database.close();
  }
}

/** Whether this browser can store keys at all.
 *
 *  Private windows in some browsers expose `indexedDB` and then fail on open,
 *  so the check has to be a real open rather than a property test. Callers use
 *  this to explain why encryption is unavailable instead of failing silently
 *  when the user tries to send. */
export async function storageIsAvailable(): Promise<boolean> {
  try {
    const database = await openDatabase();
    database.close();
    return true;
  } catch {
    return false;
  }
}

export async function loadIdentity(
  userId: string,
): Promise<{ identity: IdentityKeyPair; fingerprint: string } | null> {
  try {
    const stored = await withStore<StoredIdentity | undefined>('readonly', (store) =>
      store.get(userId),
    );
    if (!stored) return null;
    return {
      identity: {
        exchangePublicKey: stored.exchangePublicKey,
        exchangePrivateKey: stored.exchangePrivateKey,
        signingPublicKey: stored.signingPublicKey,
        signingPrivateKey: stored.signingPrivateKey,
      },
      fingerprint: stored.fingerprint,
    };
  } catch {
    // A browser that cannot read its own store is indistinguishable from one
    // that has nothing stored, and both mean the same thing to the caller.
    return null;
  }
}

export async function saveIdentity(
  userId: string,
  identity: IdentityKeyPair,
  fingerprint: string,
): Promise<void> {
  const record: StoredIdentity = { userId, ...identity, fingerprint };
  await withStore('readwrite', (store) => store.put(record));
}

/** Forget this account's keys on this device.
 *
 *  Not called on sign-out by default, and the comment here used to say it was.
 *  Signing out keeps the keys so the next sign-in does not need the password or
 *  the recovery code again — which is the right default on a device somebody
 *  owns, and the wrong one on a shared browser, where the next person can read
 *  every past message.
 *
 *  So the choice is made where it can be made honestly: `useLogout` takes it,
 *  and the interface offers both. This function is what the second one calls. */
export async function forgetIdentity(userId: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(userId));
  } catch {
    // Nothing to do about a store that will not open, and throwing here would
    // block sign-out — which is worse than a key that outlives the session.
  }
}
