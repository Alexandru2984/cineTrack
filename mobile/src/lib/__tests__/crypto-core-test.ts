import {
  decryptMessage,
  deriveWrappingKey,
  encryptMessage,
  equalBytes,
  fingerprint,
  frankingCommitment,
  generateIdentity,
  generateRecoveryCode,
  unwrapIdentity,
  wrapIdentity,
} from '@/lib/crypto/core';

const CLIENT_NONCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** See the web copy: production cost would add minutes to this suite under
 *  Jest's transformed runtime, and proves nothing the server does not enforce. */
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

  it('preserves Romanian diacritics and emoji exactly', () => {
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

  it('refuses a tampered ciphertext rather than returning wrong text', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = encryptMessage(
      'intact',
      bob.exchangePublicKey,
      alice.signingPrivateKey,
      CLIENT_NONCE,
    );
    envelope.ciphertext[0] ^= 0x01;

    expect(() => decryptMessage(envelope, bob.exchangePrivateKey)).toThrow();
  });

  it('flags a message whose commitment does not match its content', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const envelope = encryptMessage(
      'what was sent',
      bob.exchangePublicKey,
      alice.signingPrivateKey,
      CLIENT_NONCE,
    );
    envelope.frankingCommitment = frankingCommitment(new Uint8Array(32), 'something else');

    const opened = decryptMessage(envelope, bob.exchangePrivateKey);
    expect(opened.commitmentVerified).toBe(false);
  });
});

describe('key backup', () => {
  it('round-trips an identity through a password', () => {
    const identity = generateIdentity();
    const salt = new Uint8Array(16).fill(7);
    const key = deriveWrappingKey('correct horse battery staple', salt, CHEAP_KDF);

    const restored = unwrapIdentity(wrapIdentity(identity, key), key);
    expect(equalBytes(restored.exchangePrivateKey, identity.exchangePrivateKey)).toBe(true);
  });

  it('cannot be unwrapped with the wrong password', () => {
    const identity = generateIdentity();
    const salt = new Uint8Array(16).fill(7);
    const wrapped = wrapIdentity(identity, deriveWrappingKey('right', salt, CHEAP_KDF));

    expect(() => unwrapIdentity(wrapped, deriveWrappingKey('wrong', salt, CHEAP_KDF))).toThrow();
  });
});

describe('fingerprints and recovery codes', () => {
  it('changes if either public key is substituted', () => {
    const alice = generateIdentity();
    const impostor = generateIdentity();
    const genuine = fingerprint(alice.exchangePublicKey, alice.signingPublicKey);

    expect(fingerprint(impostor.exchangePublicKey, alice.signingPublicKey)).not.toBe(genuine);
    expect(fingerprint(alice.exchangePublicKey, impostor.signingPublicKey)).not.toBe(genuine);
  });

  it('avoids characters confused by hand', () => {
    expect(generateRecoveryCode()).toMatch(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/);
  });
});
