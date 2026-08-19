import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF_COST,
  decryptMessage,
  deriveWrappingKey,
  encryptMessage,
  equalBytes,
  fingerprint,
  frankingCommitment,
  fromHex,
  generateIdentity,
  generateRecoveryCode,
  toHex,
  unwrapIdentity,
  wrapIdentity,
} from '@/lib/crypto/core';

const CLIENT_NONCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** Argon2id is deliberately expensive; at production cost these assertions
 *  would each take about half a second. The algorithm is identical at any
 *  cost, and the production floor is enforced by the server and pinned below. */
const CHEAP_KDF = { memoryKib: 64, iterations: 1, parallelism: 1 };

describe('message encryption', () => {
  it('round-trips a message between two identities', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const plaintext = 'the thing I only want Bob to read';

    const envelope = encryptMessage(
      plaintext,
      bob.exchangePublicKey,
      alice.signingPrivateKey,
      CLIENT_NONCE,
    );
    const opened = decryptMessage(envelope, bob.exchangePrivateKey);

    expect(opened.plaintext).toBe(plaintext);
    expect(opened.commitmentVerified).toBe(true);
  });

  it('preserves non-ASCII text exactly', () => {
    // Romanian diacritics are the daily case here, and a UTF-8 slip would
    // corrupt them silently rather than failing.
    const alice = generateIdentity();
    const bob = generateIdentity();
    const plaintext = 'Mă uit la Silo — sezonul 2, episodul 4. 🎬';

    const envelope = encryptMessage(
      plaintext,
      bob.exchangePublicKey,
      alice.signingPrivateKey,
      CLIENT_NONCE,
    );
    expect(decryptMessage(envelope, bob.exchangePrivateKey).plaintext).toBe(plaintext);
  });

  it('cannot be opened by anybody else', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eavesdropper = generateIdentity();

    const envelope = encryptMessage(
      'private',
      bob.exchangePublicKey,
      alice.signingPrivateKey,
      CLIENT_NONCE,
    );
    expect(() => decryptMessage(envelope, eavesdropper.exchangePrivateKey)).toThrow();
  });

  it('produces a different ciphertext every time', () => {
    // A fresh ephemeral key and nonce per message: identical plaintexts must
    // not be identifiable as such by anyone watching the stored rows.
    const alice = generateIdentity();
    const bob = generateIdentity();
    const first = encryptMessage('same words', bob.exchangePublicKey, alice.signingPrivateKey, CLIENT_NONCE);
    const second = encryptMessage('same words', bob.exchangePublicKey, alice.signingPrivateKey, CLIENT_NONCE);

    expect(equalBytes(first.ciphertext, second.ciphertext)).toBe(false);
    expect(equalBytes(first.senderEphemeralKey, second.senderEphemeralKey)).toBe(false);
    expect(equalBytes(first.nonce, second.nonce)).toBe(false);
  });

  it('refuses a tampered ciphertext rather than returning wrong text', () => {
    // AES-GCM is authenticated; a flipped bit must fail loudly, because
    // silently returning altered text is far worse than an error.
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = encryptMessage('intact', bob.exchangePublicKey, alice.signingPrivateKey, CLIENT_NONCE);
    envelope.ciphertext[0] ^= 0x01;

    expect(() => decryptMessage(envelope, bob.exchangePrivateKey)).toThrow();
  });

  it('flags a message whose commitment does not match its content', () => {
    // A sender can encrypt one thing and commit to another, leaving the
    // recipient unable to report what they actually received. The mismatch has
    // to be visible, because a message nobody can report is itself the
    // report-worthy event.
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = encryptMessage('what was sent', bob.exchangePublicKey, alice.signingPrivateKey, CLIENT_NONCE);
    envelope.frankingCommitment = frankingCommitment(new Uint8Array(32), 'something else');

    const opened = decryptMessage(envelope, bob.exchangePrivateKey);
    expect(opened.plaintext).toBe('what was sent');
    expect(opened.commitmentVerified).toBe(false);
  });

  it('gives the recipient the franking key, so they can report', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const plaintext = 'reportable';
    const envelope = encryptMessage(plaintext, bob.exchangePublicKey, alice.signingPrivateKey, CLIENT_NONCE);

    const opened = decryptMessage(envelope, bob.exchangePrivateKey);
    expect(opened.frankingKey).toHaveLength(32);
    // The key the recipient holds is exactly the one that opens the stored
    // commitment — this is what the server will check on a report.
    expect(
      equalBytes(frankingCommitment(opened.frankingKey, plaintext), envelope.frankingCommitment),
    ).toBe(true);
  });
});

describe('key backup', () => {
  it('round-trips an identity through a password', () => {
    const identity = generateIdentity();
    const salt = new Uint8Array(16).fill(7);
    const key = deriveWrappingKey('correct horse battery staple', salt, CHEAP_KDF);

    const restored = unwrapIdentity(wrapIdentity(identity, key), key);
    expect(equalBytes(restored.exchangePrivateKey, identity.exchangePrivateKey)).toBe(true);
    expect(equalBytes(restored.signingPublicKey, identity.signingPublicKey)).toBe(true);
  });

  it('cannot be unwrapped with the wrong password', () => {
    const identity = generateIdentity();
    const salt = new Uint8Array(16).fill(7);
    const wrapped = wrapIdentity(identity, deriveWrappingKey('right', salt, CHEAP_KDF));

    expect(() => unwrapIdentity(wrapped, deriveWrappingKey('wrong', salt, CHEAP_KDF))).toThrow();
  });

  it('derives a different key for a different salt', () => {
    // Per-account salts are what stop one precomputation attacking every
    // backup in a stolen copy of the table.
    const a = deriveWrappingKey('same password', new Uint8Array(16).fill(1), CHEAP_KDF);
    const b = deriveWrappingKey('same password', new Uint8Array(16).fill(2), CHEAP_KDF);
    expect(equalBytes(a, b)).toBe(false);
  });

  it('uses parameters at or above the floor the server enforces', () => {
    // The server refuses a weaker backup, so a client shipping weaker defaults
    // would fail to publish rather than quietly store something attackable.
    expect(DEFAULT_KDF_COST.memoryKib).toBeGreaterThanOrEqual(19456);
    expect(DEFAULT_KDF_COST.iterations).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_KDF_COST.parallelism).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_KDF_COST.parallelism).toBeLessThanOrEqual(4);
  });

  it('refuses truncated wrapped material', () => {
    expect(() => unwrapIdentity(new Uint8Array(8), new Uint8Array(32))).toThrow();
  });
});

describe('fingerprints', () => {
  it('changes if either public key is substituted', () => {
    // The only defence against the server handing out a key of its own is that
    // the substitution is visible when two people compare.
    const alice = generateIdentity();
    const impostor = generateIdentity();

    const genuine = fingerprint(alice.exchangePublicKey, alice.signingPublicKey);
    expect(fingerprint(impostor.exchangePublicKey, alice.signingPublicKey)).not.toBe(genuine);
    expect(fingerprint(alice.exchangePublicKey, impostor.signingPublicKey)).not.toBe(genuine);
  });

  it('is stable and shaped as the server expects', () => {
    const identity = generateIdentity();
    const value = fingerprint(identity.exchangePublicKey, identity.signingPublicKey);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(identity.exchangePublicKey, identity.signingPublicKey)).toBe(value);
  });
});

describe('encoding helpers', () => {
  it('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it('refuses malformed hex rather than guessing', () => {
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
});

describe('recovery codes', () => {
  it('is grouped and avoids characters confused by hand', () => {
    // Written down and typed back by a person; a code copied wrong is a
    // history lost, so ambiguous glyphs are excluded.
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/);
    expect(code).not.toMatch(/[01IO]/);
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(50);
  });
});
