/// Derive a wrapping key without blocking the interface.
///
/// Falls back to deriving in place where a worker cannot be created — a
/// hardened browser, a test environment, a context with no `Worker`. The result
/// is identical either way; only the thread differs, so the fallback is a
/// slower experience rather than a different one.
import type { KdfCost } from '@/lib/crypto/core';

// Loaded on demand, like every other use of these primitives. A static import
// here would pull a third of a megabyte of crypto onto the initial route for a
// fallback that most sessions never take — which is exactly the cost
// `session.ts` goes out of its way to avoid.
const core = () => import('@/lib/crypto/core');

async function deriveInPlace(
  secret: string,
  salt: Uint8Array,
  cost: KdfCost,
): Promise<Uint8Array> {
  const { deriveWrappingKey } = await core();
  return deriveWrappingKey(secret, salt, cost);
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (key: Uint8Array) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; key?: Uint8Array; error?: string }>) => {
      const waiting = pending.get(event.data.id);
      if (!waiting) return;
      pending.delete(event.data.id);
      if (event.data.error) waiting.reject(new Error(event.data.error));
      else waiting.resolve(new Uint8Array(event.data.key as Uint8Array));
    };
    worker.onerror = () => {
      // The worker is gone; fail everything waiting on it and let the next call
      // fall back rather than hanging forever on a dead thread.
      for (const [, waiting] of pending) waiting.reject(new Error('derivation worker failed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

export async function deriveWrappingKeyOffThread(
  secret: string,
  salt: Uint8Array,
  cost: KdfCost,
): Promise<Uint8Array> {
  const active = ensureWorker();
  if (!active) return deriveInPlace(secret, salt, cost);

  const id = nextId++;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // The salt is copied rather than transferred: the caller keeps using it to
    // build the request it sends to the server.
    active.postMessage({ id, secret, salt: new Uint8Array(salt), cost });
  }).catch(() => deriveInPlace(secret, salt, cost));
}
