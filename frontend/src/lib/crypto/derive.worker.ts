/// Argon2id, off the thread that draws the interface.
///
/// L04 of the September audit. The derivation is deliberately expensive — 32
/// MiB and three passes — and it ran synchronously on the main thread, twice
/// during setup. Measured at roughly half a second on a desktop; on a slow
/// Android that is long enough that the screen stops responding and somebody
/// presses the button again, which is the worst possible moment for it.
///
/// The cost is not reduced. Reducing it to hide the freeze would weaken the
/// thing it is there to do.
import { deriveWrappingKey, type KdfCost } from '@/lib/crypto/core';

export interface DeriveRequest {
  id: number;
  secret: string;
  salt: Uint8Array;
  cost: KdfCost;
}

self.onmessage = (event: MessageEvent<DeriveRequest>) => {
  const { id, secret, salt, cost } = event.data;
  try {
    const key = deriveWrappingKey(secret, salt, cost);
    // Transferred, not copied: the buffer is of no further use here.
    (self as unknown as Worker).postMessage({ id, key }, [key.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      error: error instanceof Error ? error.message : 'derivation failed',
    });
  }
};
