import { getRandomValues } from 'expo-crypto';

import { generateIdentity, generateRecoveryCode } from '@/lib/crypto/core';
import { installRandomSource } from '@/lib/crypto/random';

// Hoisted above the imports by Jest. The factory runs when the imports first
// load expo-crypto, while Node's own `crypto` global is still in place, so the
// mock can keep drawing from it after a test takes the global away.
jest.mock('expo-crypto', () => {
  const nodeCrypto = globalThis.crypto;
  return {
    getRandomValues: jest.fn(<T extends Uint8Array<ArrayBuffer>>(array: T): T =>
      nodeCrypto.getRandomValues(array),
    ),
  };
});

const expoGetRandomValues = getRandomValues as jest.MockedFunction<typeof getRandomValues>;

/** Node has `globalThis.crypto`; Hermes does not. These tests take it away to
 *  run the key code the way a phone does, and put Node's back afterwards. */
const nodeCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function withoutGlobalCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (nodeCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', nodeCryptoDescriptor);
  expoGetRandomValues.mockClear();
});

describe('installRandomSource', () => {
  it('reproduces the phone: without a crypto global the key code throws', () => {
    withoutGlobalCrypto();
    expect(() => generateIdentity()).toThrow('crypto.getRandomValues must be defined');
  });

  it('lets a phone generate an identity and a recovery code', () => {
    withoutGlobalCrypto();
    installRandomSource();

    const identity = generateIdentity();
    const code = generateRecoveryCode();

    expect(identity.exchangePublicKey).toHaveLength(32);
    expect(identity.signingPublicKey).toHaveLength(32);
    expect(code.length).toBeGreaterThan(0);
    expect(expoGetRandomValues).toHaveBeenCalled();
  });

  it('adds the call to a crypto object that lacks it, keeping the rest', () => {
    const subtle = {};
    const target = { crypto: { subtle } as { subtle: object; getRandomValues?: unknown } };

    installRandomSource(target);

    expect(target.crypto.subtle).toBe(subtle);
    const bytes = (target.crypto.getRandomValues as (array: Uint8Array) => Uint8Array)(
      new Uint8Array(16),
    );
    expect(bytes).toHaveLength(16);
    expect(expoGetRandomValues).toHaveBeenCalledTimes(1);
  });

  it('leaves a runtime that already has the call alone', () => {
    const own = jest.fn();
    const target = { crypto: { getRandomValues: own } };

    installRandomSource(target);

    expect(target.crypto.getRandomValues).toBe(own);
    expect(expoGetRandomValues).not.toHaveBeenCalled();
  });
});
