/** `crypto.getRandomValues` for the native runtime.
 *
 *  The @noble libraries behind every key, nonce and recovery code here read
 *  their randomness from `globalThis.crypto.getRandomValues`, the Web Crypto
 *  call. Browsers and Node have it. React Native does not: Hermes ships no
 *  `crypto` global and neither React Native nor Expo installs one. So on a
 *  phone the first `randomSecretKey()` threw "crypto.getRandomValues must be
 *  defined", before the setup request was ever sent, and the screen could only
 *  say that encryption could not be turned on. Every test passed, because Jest
 *  runs on Node, which has the global.
 *
 *  This fills the gap with expo-crypto, which is already a dependency and
 *  draws from the platform's secure generator (SecureRandom on Android,
 *  SecRandomCopyBytes on iOS). A runtime that already has the call keeps its
 *  own; nothing is replaced. */
import { getRandomValues } from 'expo-crypto';

type FillableArray = Parameters<typeof getRandomValues>[0];

interface RandomSource {
  getRandomValues?: unknown;
}

function fill<T extends FillableArray>(array: T): T {
  return getRandomValues(array);
}

/** Give `target` a working `crypto.getRandomValues` if it lacks one.
 *
 *  Takes the target as an argument so the tests can exercise a global without
 *  the call, the way Hermes presents it, without touching Node's own. */
export function installRandomSource(target: object = globalThis): void {
  const existing = (target as { crypto?: RandomSource }).crypto;
  if (typeof existing?.getRandomValues === 'function') return;

  if (existing && typeof existing === 'object') {
    // Some other `crypto` object without the call; add it rather than replace
    // whatever else that object carries.
    Object.defineProperty(existing, 'getRandomValues', {
      value: fill,
      configurable: true,
      writable: true,
    });
    return;
  }

  Object.defineProperty(target, 'crypto', {
    value: { getRandomValues: fill },
    configurable: true,
    writable: true,
  });
}

installRandomSource();
