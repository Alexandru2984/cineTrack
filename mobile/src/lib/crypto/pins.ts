/** What this device remembers about contacts' keys, so a change can be noticed.
 *
 *  AsyncStorage rather than the keychain the private keys live in. The keychain
 *  is for secrets, and a pin is not one — it is a fingerprint the directory
 *  gives anyone who asks. What it has to resist is the server replacing it, and
 *  the server cannot reach this app's sandbox. There is a practical reason too:
 *  SecureStore can neither list nor bulk-delete its entries, and pins have to
 *  go together when somebody asks this device to forget an account.
 *
 *  Scoped by the signed-in account, so two accounts on one phone keep separate
 *  pins. */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { isPeerPin, type PeerPin } from '@/lib/crypto/trust';

const PREFIX = 'vazute.e2ee.pins.';

function storageKey(ownUserId: string): string {
  return `${PREFIX}${ownUserId}`;
}

async function readAll(ownUserId: string): Promise<Record<string, unknown>> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(ownUserId));
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
  const pin = (await readAll(ownUserId))[peerUserId];
  return isPeerPin(pin) ? pin : null;
}

export async function savePin(ownUserId: string, peerUserId: string, pin: PeerPin): Promise<void> {
  try {
    const all = await readAll(ownUserId);
    all[peerUserId] = pin;
    await AsyncStorage.setItem(storageKey(ownUserId), JSON.stringify(all));
  } catch {
    // A full or unavailable store costs the warning, not the conversation.
  }
}

/** Forget every pin this account holds on this device. */
export async function forgetPins(ownUserId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(ownUserId));
  } catch {
    // As with the keys: throwing here would block sign-out.
  }
}
