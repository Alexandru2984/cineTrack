/** Decrypted message text, held for as long as the session lasts.
 *
 *  Separate from `messages.ts` so that clearing the cache does not drag the
 *  cryptography into whatever bundle asks for it. The store clears this on
 *  sign-out and lives on the initial route; the primitives are a third of a
 *  megabyte and belong in the chunk that actually encrypts something.
 *
 *  Caching at all is what makes decryption safe to call from render: an X25519
 *  agreement per message is nothing once and noticeable when a fifty-message
 *  thread re-renders on every keystroke. Messages are immutable, so an entry
 *  keyed by id can never be stale. */
export interface DecryptedContent {
  text: string;
  /** Opens the sender's commitment. Held only in memory, and only so a report
   *  can carry it: it is the difference between a moderator seeing text the
   *  sender provably wrote and text the reporter typed. */
  frankingKey: Uint8Array;
  /** False when the sender encrypted one thing and committed to another. Such a
   *  message cannot be reported, so saying so beats showing it as ordinary.
   *
   *  `null` means nothing was checked, because the envelope carried no
   *  commitment to check against. A conversation preview is exactly that, and
   *  conflating it with `false` had a real consequence: the preview cached its
   *  own answer under the message id, the thread view found that entry and
   *  trusted it, and the newest message of every conversation was labelled a
   *  commitment mismatch. Absence of a verdict is not a negative verdict. */
  commitmentVerified: boolean | null;
  /** Whether the account this claims to be from actually signed it.
   *
   *  * `verified` — signed by the key behind the safety number.
   *  * `unchecked` — nothing to check against: no trusted key was on hand.
   *  * `unrecognised` — the signature does not verify under the key the sender
   *    publishes today, and the key it was made with is either not recorded or
   *    is a different one. A key rotation looks exactly like this.
   *  * `forged` — it fails under the very key the message is recorded as having
   *    been signed with. Nothing legitimate produces that. */
  authenticity: MessageAuthenticity;
}

export type MessageAuthenticity = 'verified' | 'unchecked' | 'unrecognised' | 'forged';

const cache = new Map<string, DecryptedContent>();
/** Bounded so a long-lived tab scrolling years of history cannot grow without
 *  limit. Oldest-first eviction matches how threads are read. */
const CACHE_LIMIT = 500;

export function lookup(id: string): DecryptedContent | undefined {
  return cache.get(id);
}

export function remember(id: string, content: DecryptedContent) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(id, content);
}

/** Forget every decrypted message. Called on sign-out, so plaintext does not
 *  outlive the session in memory. */
export function clearDecryptionCache() {
  cache.clear();
}
