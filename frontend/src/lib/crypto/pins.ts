/** What this browser remembers about contacts' keys, so a change can be noticed.
 *
 *  localStorage rather than the IndexedDB store the private keys live in, and
 *  the difference is deliberate. `storage.ts` keeps keys in IndexedDB for
 *  reasons that are about secrets: raw bytes without a base64 round trip, and
 *  out of reach of the tools that treat localStorage as a scratchpad. A pin is
 *  not a secret — it is a fingerprint the directory gives anyone who asks. What
 *  it has to resist is the server replacing it, and the server cannot reach
 *  this origin's storage in either place.
 *
 *  Scoped by the signed-in account, so two people on one browser keep separate
 *  pins, and cleared along with that account's keys when somebody asks this
 *  device to forget them — otherwise a shared browser would keep a list of who
 *  they had been writing to. */
import { isPeerPin, type PeerPin } from '@/lib/crypto/trust';

const PREFIX = 'vazute.e2ee.pins.';

function storageKey(ownUserId: string): string {
  return `${PREFIX}${ownUserId}`;
}

function readAll(ownUserId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(storageKey(ownUserId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Unreadable is treated as empty. The worst outcome is a silent re-pin,
    // never a false warning — see `comparePeerKeys`.
    return {};
  }
}

/** The pin for one contact, or null when there is none worth trusting. */
export async function loadPin(ownUserId: string, peerUserId: string): Promise<PeerPin | null> {
  const pin = readAll(ownUserId)[peerUserId];
  return isPeerPin(pin) ? pin : null;
}

export async function savePin(ownUserId: string, peerUserId: string, pin: PeerPin): Promise<void> {
  try {
    const all = readAll(ownUserId);
    all[peerUserId] = pin;
    localStorage.setItem(storageKey(ownUserId), JSON.stringify(all));
  } catch {
    // A full or blocked store costs the warning, not the conversation.
  }
}

/** Forget every pin this account holds on this browser. */
export async function forgetPins(ownUserId: string): Promise<void> {
  try {
    localStorage.removeItem(storageKey(ownUserId));
  } catch {
    // As with the keys: throwing here would block sign-out.
  }
}
