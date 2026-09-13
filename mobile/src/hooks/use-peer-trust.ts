import { useCallback, useEffect, useState } from 'react';

import { loadPin, savePin } from '@/lib/crypto/pins';
import { comparePeerKeys, pinFor, type PeerTrust } from '@/lib/crypto/trust';

/** The contact whose keys are being checked: who they are, and the fingerprint
 *  derived from the keys the directory served just now. */
export interface PeerIdentity {
  userId: string;
  username: string;
  fingerprint: string;
}

/** Whether this contact's keys are the ones this device saw before.
 *
 *  Pins on first contact, silently. Reports `changed` when a later directory
 *  entry derives to a different fingerprint, and keeps reporting it — across
 *  reloads — until the member accepts the new key. Accepting is theirs to do,
 *  so it is never done on their behalf: a warning that clears itself on the
 *  next load is one an attacker only has to wait out.
 *
 *  `null` while the pin is being read, which the page treats as nothing to say
 *  yet rather than as either answer. */
export function usePeerTrust(ownUserId: string | null, peer: PeerIdentity | null) {
  const peerUserId = peer?.userId ?? null;
  const username = peer?.username ?? null;
  const fingerprint = peer?.fingerprint ?? null;
  const currentKey =
    ownUserId && peerUserId && fingerprint ? `${ownUserId}:${peerUserId}:${fingerprint}` : null;
  const [result, setResult] = useState<{ key: string; trust: PeerTrust } | null>(null);

  useEffect(() => {
    if (!ownUserId || !peerUserId || !username || !fingerprint || !currentKey) return;
    let cancelled = false;
    void (async () => {
      const trust = comparePeerKeys(await loadPin(ownUserId, peerUserId), fingerprint);
      if (trust === 'first-contact') {
        await savePin(ownUserId, peerUserId, pinFor(fingerprint, username));
      }
      if (!cancelled) setResult({ key: currentKey, trust });
    })();
    return () => {
      cancelled = true;
    };
  }, [ownUserId, peerUserId, username, fingerprint, currentKey]);

  const accept = useCallback(async () => {
    if (!ownUserId || !peerUserId || !username || !fingerprint || !currentKey) return;
    await savePin(ownUserId, peerUserId, pinFor(fingerprint, username));
    setResult({ key: currentKey, trust: 'unchanged' });
  }, [ownUserId, peerUserId, username, fingerprint, currentKey]);

  return { trust: result && result.key === currentKey ? result.trust : null, accept };
}
