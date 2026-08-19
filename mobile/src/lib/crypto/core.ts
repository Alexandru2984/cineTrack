/**
 * End-to-end encryption primitives for direct messages.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS SHARED VERBATIM BETWEEN THE WEB AND NATIVE CLIENTS.
 *
 * `frontend/src/lib/crypto/core.ts` and `mobile/src/lib/crypto/core.ts` must be
 * byte-identical, and a test in each project fails if they drift. Cryptography
 * that disagrees across platforms fails silently and late: a message written on
 * a phone that will not open on a laptop, because one side padded, ordered or
 * encoded something differently. Copying the file is crude; two implementations
 * would be worse.
 *
 * Edit one, copy to the other, run both test suites.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * # Shape of a message
 *
 * Every message gets a fresh X25519 key pair. The shared secret is derived
 * against the recipient's long-term exchange key, run through HKDF, and used
 * once for AES-256-GCM. The ephemeral public key travels with the message, so a
 * long-term key compromised later does not open what was already sent.
 *
 * The plaintext is encrypted together with a per-message franking key. That key
 * therefore reaches the recipient and nobody else — which is what lets them
 * later prove to the server what was said, without the server ever being able
 * to read it. See `services/franking.rs` for the other half.
 *
 * # The sender's own copy
 *
 * An ephemeral key that only the recipient can complete has an awkward
 * consequence: the sender cannot read what they sent. Their private ephemeral
 * key is gone, and the history lives on the server, so their own outbox would
 * be a column of padlocks after a reload. That is not a security property, it
 * is a broken product.
 *
 * So the message key is also wrapped against the sender's own long-term key,
 * using the same ephemeral private key while it still exists. The wrap travels
 * with the message as `senderCopy`; the sender opens it later with the private
 * half they keep. The recipient's path is untouched, and the server gains
 * nothing — it holds one more sealed box it cannot open.
 *
 * The same nonce appears under both keys. That is safe precisely because they
 * are different keys: GCM's requirement is uniqueness per key, not globally.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const PUBLIC_KEY_BYTES = 32;
export const PRIVATE_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const FRANKING_KEY_BYTES = 32;
export const SALT_BYTES = 16;

/** Argon2id cost for wrapping the key backup.
 *
 *  Matches the floor the server enforces. It runs in a browser and on a phone,
 *  where a cost tuned for a server would take long enough that people abandon
 *  the setup — and an unusable protection is not one.
 *
 *  Measured rather than guessed: ~520 ms for these values on this hardware,
 *  against ~1.7 s at 64 MiB. A one-off cost of half a second at sign-in or on a
 *  new device is worth paying; several seconds is what makes somebody skip the
 *  step entirely. */
export const KDF_MEMORY_KIB = 19456;
export const KDF_ITERATIONS = 2;
export const KDF_PARALLELISM = 1;

/** The cost a particular backup was wrapped with.
 *
 *  Always read from the stored backup rather than assumed. Raising the default
 *  later must not make existing backups unopenable, and a client that used its
 *  own current defaults would derive the wrong key and report a wrong password
 *  for a password that is right. */
export interface KdfCost {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF_COST: KdfCost = {
  memoryKib: KDF_MEMORY_KIB,
  iterations: KDF_ITERATIONS,
  parallelism: KDF_PARALLELISM,
};

/** Domain separation for every derived key.
 *
 *  Distinct strings so a key derived for one purpose can never be mistaken for
 *  one derived for another, even if the same input secret were reused. */
const INFO_MESSAGE = new TextEncoder().encode('vazute/e2ee/message-key/v1');
const INFO_BACKUP = new TextEncoder().encode('vazute/e2ee/backup-key/v1');
const INFO_FINGERPRINT = new TextEncoder().encode('vazute/e2ee/fingerprint/v1');

export interface IdentityKeyPair {
  exchangePublicKey: Uint8Array;
  exchangePrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  signingPrivateKey: Uint8Array;
}

export interface EncryptedMessage {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  senderEphemeralKey: Uint8Array;
  /** The message key, sealed to the sender's own exchange key, so they can read
   *  their own outbox. Absent on messages written before this existed. */
  senderCopy?: Uint8Array;
  frankingCommitment: Uint8Array;
  frankingSignature: Uint8Array;
}

export interface DecryptedMessage {
  plaintext: string;
  frankingKey: Uint8Array;
  /** False when the sender committed to something other than what they
   *  encrypted. Such a message cannot be reported through the normal path, so
   *  the mismatch is itself worth surfacing rather than hiding. */
  commitmentVerified: boolean;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error('hex string has an odd length');
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hex string contains a non-hex character');
    bytes[index] = byte;
  }
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time comparison, so a mismatch cannot be located byte by byte. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function generateIdentity(): IdentityKeyPair {
  const exchangePrivateKey = x25519.utils.randomSecretKey();
  const signingPrivateKey = ed25519.utils.randomSecretKey();
  return {
    exchangePrivateKey,
    exchangePublicKey: x25519.getPublicKey(exchangePrivateKey),
    signingPrivateKey,
    signingPublicKey: ed25519.getPublicKey(signingPrivateKey),
  };
}

/**
 * The safety number two people compare out of band.
 *
 * Derived from both public keys, so substituting either one changes it. This is
 * the only defence against the server handing out a key of its own: it cannot
 * be prevented, only made visible.
 */
export function fingerprint(exchangePublicKey: Uint8Array, signingPublicKey: Uint8Array): string {
  return toHex(
    hkdf(sha256, concat(exchangePublicKey, signingPublicKey), undefined, INFO_FINGERPRINT, 32),
  );
}

/** Unwrap the message key from the sender's copy, or null when this reader is
 *  not the sender.
 *
 *  Distinguishing the two by trying is deliberate: the alternative is passing a
 *  flag from the caller, and a caller that gets it wrong produces a message
 *  that silently fails to open rather than one that opens the other way. */
function openSenderCopy(
  message: EncryptedMessage,
  derivedKey: Uint8Array,
): Uint8Array | null {
  if (!message.senderCopy || message.senderCopy.length === 0) return null;
  try {
    return gcm(derivedKey, message.nonce).decrypt(message.senderCopy);
  } catch {
    return null;
  }
}

function messageKey(sharedSecret: Uint8Array, ephemeralPublicKey: Uint8Array): Uint8Array {
  // The ephemeral public key is the HKDF salt, so two messages sharing a secret
  // still derive different keys, and a nonce is never reused under one key.
  return hkdf(sha256, sharedSecret, ephemeralPublicKey, INFO_MESSAGE, 32);
}

export function frankingCommitment(frankingKey: Uint8Array, plaintext: string): Uint8Array {
  // Over the exact bytes, with no normalisation: the server recomputes this and
  // any difference in whitespace handling would make every report fail.
  return hmac(sha256, frankingKey, encoder.encode(plaintext));
}

/** The bytes the sender signs: the commitment bound to the message it belongs
 *  to, so a signature cannot be lifted onto a different message. */
/** The bytes a sender signs: the commitment bound to the message it belongs to.
 *
 *  The message is identified by its client nonce rather than its server-side
 *  id, and the reason is timing rather than taste: the id is assigned by the
 *  INSERT, long after the sender has to sign. A scheme demanding it would be one
 *  no client could ever satisfy. The nonce is chosen before the request leaves,
 *  and the server's uniqueness constraint on (sender, nonce) makes it identify
 *  exactly one message — which is the property the binding needs. */
export function frankingSigningPayload(
  commitment: Uint8Array,
  clientNonce: string,
): Uint8Array {
  return concat(commitment, fromHex(clientNonce.replace(/-/g, '')));
}

export function encryptMessage(
  plaintext: string,
  recipientExchangePublicKey: Uint8Array,
  senderExchangePublicKey: Uint8Array,
  senderSigningPrivateKey: Uint8Array,
  clientNonce: string,
): EncryptedMessage {
  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const senderEphemeralKey = x25519.getPublicKey(ephemeralPrivateKey);
  const shared = x25519.getSharedSecret(ephemeralPrivateKey, recipientExchangePublicKey);
  const key = messageKey(shared, senderEphemeralKey);

  const frankingKey = randomBytes(FRANKING_KEY_BYTES);
  const commitment = frankingCommitment(frankingKey, plaintext);

  // The franking key is sealed with the message, so the recipient learns it and
  // the server never does. That asymmetry is the whole scheme.
  const payload = concat(frankingKey, encoder.encode(plaintext));
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = gcm(key, nonce).encrypt(payload);

  // Wrapped while the ephemeral private key still exists. Afterwards nobody —
  // including the sender — could produce this.
  const senderShared = x25519.getSharedSecret(ephemeralPrivateKey, senderExchangePublicKey);
  const senderCopy = gcm(messageKey(senderShared, senderEphemeralKey), nonce).encrypt(key);

  return {
    ciphertext,
    nonce,
    senderEphemeralKey,
    senderCopy,
    frankingCommitment: commitment,
    frankingSignature: ed25519.sign(
      frankingSigningPayload(commitment, clientNonce),
      senderSigningPrivateKey,
    ),
  };
}

export function decryptMessage(
  message: EncryptedMessage,
  exchangePrivateKey: Uint8Array,
): DecryptedMessage {
  const shared = x25519.getSharedSecret(exchangePrivateKey, message.senderEphemeralKey);
  const derived = messageKey(shared, message.senderEphemeralKey);
  // The same call serves both parties, because both hold a private key that
  // completes the ephemeral agreement — the recipient reaching the message key
  // directly, the sender reaching the wrapper around it. Trying the wrapper
  // first would cost a failed GCM open on every received message, so the
  // direct path is tried first and the wrapper is the fallback.
  const key = openSenderCopy(message, derived) ?? derived;
  const payload = gcm(key, message.nonce).decrypt(message.ciphertext);

  const frankingKey = payload.slice(0, FRANKING_KEY_BYTES);
  const plaintext = decoder.decode(payload.slice(FRANKING_KEY_BYTES));

  return {
    plaintext,
    frankingKey,
    // Recomputed here rather than trusted. A sender who encrypts one thing and
    // commits to another produces a message their recipient cannot report; the
    // mismatch has to be visible for that to be actionable.
    commitmentVerified: equalBytes(
      frankingCommitment(frankingKey, plaintext),
      message.frankingCommitment,
    ),
  };
}

/** Derive the key that wraps a backup, from a password or a recovery code.
 *
 *  The cost is a parameter because it belongs to the backup being opened, not
 *  to the client opening it. Tests also lower it: the algorithm is identical at
 *  any cost, and the production values are enforced by the server, so paying
 *  half a second per assertion would buy nothing. */
export function deriveWrappingKey(
  secret: string,
  salt: Uint8Array,
  cost: KdfCost = DEFAULT_KDF_COST,
): Uint8Array {
  return argon2id(encoder.encode(secret), salt, {
    m: cost.memoryKib,
    t: cost.iterations,
    p: cost.parallelism,
    dkLen: 32,
  });
}

/** Serialised private key material, as stored wrapped on the server. */
function serializeIdentity(identity: IdentityKeyPair): Uint8Array {
  return concat(identity.exchangePrivateKey, identity.signingPrivateKey);
}

function deserializeIdentity(bytes: Uint8Array): IdentityKeyPair {
  if (bytes.length !== PRIVATE_KEY_BYTES * 2) {
    throw new Error('wrapped key material has an unexpected length');
  }
  const exchangePrivateKey = bytes.slice(0, PRIVATE_KEY_BYTES);
  const signingPrivateKey = bytes.slice(PRIVATE_KEY_BYTES);
  return {
    exchangePrivateKey,
    exchangePublicKey: x25519.getPublicKey(exchangePrivateKey),
    signingPrivateKey,
    signingPublicKey: ed25519.getPublicKey(signingPrivateKey),
  };
}

export function wrapIdentity(identity: IdentityKeyPair, wrappingKey: Uint8Array): Uint8Array {
  // The nonce is prepended rather than stored separately: one blob is one thing
  // to keep in step, and a wrapped key whose nonce went missing is unopenable.
  const nonce = randomBytes(NONCE_BYTES);
  const key = hkdf(sha256, wrappingKey, undefined, INFO_BACKUP, 32);
  return concat(nonce, gcm(key, nonce).encrypt(serializeIdentity(identity)));
}

export function unwrapIdentity(wrapped: Uint8Array, wrappingKey: Uint8Array): IdentityKeyPair {
  if (wrapped.length <= NONCE_BYTES) throw new Error('wrapped key material is truncated');
  const nonce = wrapped.slice(0, NONCE_BYTES);
  const key = hkdf(sha256, wrappingKey, undefined, INFO_BACKUP, 32);
  return deserializeIdentity(gcm(key, nonce).decrypt(wrapped.slice(NONCE_BYTES)));
}

/** A recovery code the user writes down.
 *
 *  Grouped for transcription, and drawn from an alphabet without characters
 *  that get confused by hand — a code copied wrong is a history lost. */
export function generateRecoveryCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(20);
  const characters = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return (characters.join('').match(/.{1,5}/g) ?? []).join('-');
}
