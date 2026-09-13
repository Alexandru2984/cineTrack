/** Whether a contact's keys are the ones this device has seen before.
 *
 *  The safety number already follows the key in use — it is derived from the
 *  keys this device was handed, never from the fingerprint the directory
 *  states. What it cannot do on its own is notice. A number that changes is
 *  only a warning to somebody who wrote the old one down, and nobody does: a
 *  server that swapped a contact's key would be caught by exactly the people
 *  who compare safety numbers every time they open a thread.
 *
 *  So each device remembers the fingerprint it first saw for a contact — trust
 *  on first use, the model Signal and WhatsApp work to — and says so when the
 *  directory later serves a different one. First contact is silent: there is
 *  no earlier key to compare with, and a warning there would be noise.
 *
 *  One file, shared byte for byte by both clients like the rest of the
 *  cryptography, because the failure it guards against is the same kind: one
 *  platform warning while the other stays quiet. Where pins are stored is a
 *  platform question and lives in `pins.ts` on each side. */

/** What this device remembers about one contact's keys. */
export interface PeerPin {
  /** Derived locally from the contact's public keys — never the directory's
   *  stated fingerprint, for the same reason the safety number is not. */
  fingerprint: string;
  /** The username at the time, for display only. Pins are keyed by user id,
   *  because a username can be given up and then taken by somebody else. */
  username: string;
  /** When this key was first seen or last accepted, as an ISO timestamp. */
  pinnedAt: string;
}

/** How the keys served now compare with the ones remembered. */
export type PeerTrust = 'first-contact' | 'unchanged' | 'changed';

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Whether a stored value is a pin this code wrote, rather than something a
 *  different build left behind or that did not survive being read back. */
export function isPeerPin(value: unknown): value is PeerPin {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Record<string, unknown>;
  return (
    typeof pin.fingerprint === 'string' &&
    FINGERPRINT.test(pin.fingerprint) &&
    typeof pin.username === 'string' &&
    typeof pin.pinnedAt === 'string'
  );
}

/** The pin to store for a fingerprint seen now. Lower-cased here so that the
 *  comparison below cannot miss a match on case alone — a pin that failed
 *  `isPeerPin` would read as first contact forever and never warn. */
export function pinFor(fingerprint: string, username: string, now: Date = new Date()): PeerPin {
  return { fingerprint: fingerprint.toLowerCase(), username, pinnedAt: now.toISOString() };
}

/** Compare the fingerprint derived from the keys served now with the pin.
 *
 *  An unreadable pin counts as none. A corrupted entry therefore re-pins
 *  silently rather than raising a warning nobody could act on — acceptable,
 *  because anything able to write this device's storage is already past what
 *  this protects against: the server, which cannot reach it. */
export function comparePeerKeys(pinned: unknown, currentFingerprint: string): PeerTrust {
  if (!isPeerPin(pinned)) return 'first-contact';
  return pinned.fingerprint === currentFingerprint.toLowerCase() ? 'unchanged' : 'changed';
}
