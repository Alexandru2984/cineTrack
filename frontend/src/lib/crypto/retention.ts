/** Whether this browser keeps an account's message keys past its session.
 *
 *  The keys are stored unwrapped in IndexedDB (see `storage.ts` for why), so
 *  whoever uses the browser next can read them. Signing out kept them by
 *  default, which is right on a device somebody owns and wrong on a borrowed
 *  one, and the only way to drop them was a second button people had to know
 *  to press.
 *
 *  "Keep me signed in" is the one thing the web knows about whose browser this
 *  is. When it was left unticked the person said, in effect, that it is not
 *  theirs, so the keys now go with the session: on sign-out, and, since a
 *  session that is not kept ends when the browser closes, on the next visit
 *  that finds no session. The cost is a recovery code at the next sign-in on
 *  that browser, which is what someone on a shared machine should expect.
 *
 *  The marker records only a user id, never key material, so localStorage is
 *  the right place for it: it has to outlive the tab to be read on the next
 *  visit. */
import { forgetPins } from '@/lib/crypto/pins';
import { forgetIdentity } from '@/lib/crypto/storage';

const MARKER_PREFIX = 'vazute.e2ee.keys-leave-with-session.';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Record the choice made at sign-in. Keeping the session keeps the keys. */
export function recordKeyRetention(userId: string, keepSignedIn: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    if (keepSignedIn) store.removeItem(MARKER_PREFIX + userId);
    else store.setItem(MARKER_PREFIX + userId, '1');
  } catch {
    // A browser refusing storage keeps the old default; nothing to do here.
  }
}

/** Whether signing out should forget this account's keys by default. */
export function keysLeaveWithSession(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return storage()?.getItem(MARKER_PREFIX + userId) === '1';
  } catch {
    return false;
  }
}

function markedUsers(): string[] {
  const store = storage();
  if (!store) return [];
  const users: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(MARKER_PREFIX)) users.push(key.slice(MARKER_PREFIX.length));
    }
  } catch {
    return [];
  }
  return users;
}

/** Drop an account's marker once its keys are gone. */
export function clearKeyRetention(userId: string): void {
  try {
    storage()?.removeItem(MARKER_PREFIX + userId);
  } catch {
    // The keys are gone; a marker left behind only repeats a no-op later.
  }
}

/** Forget the keys of an account, and the contacts pinned with them. Never
 *  throws: this runs on the way into the app, and a store that will not open
 *  must not keep anyone out. */
async function forgetKeysOf(userId: string): Promise<void> {
  try {
    await forgetIdentity(userId);
    await forgetPins(userId);
    clearKeyRetention(userId);
  } catch {
    // Left for the next visit to try again.
  }
}

/** Forget the keys of every account whose session was not kept and is no
 *  longer the one signed in here: a browser closed without signing out, or a
 *  different account signed in since. `currentUserId` is the account whose
 *  session is live now, if any. */
export async function forgetKeysOfEndedSessions(currentUserId: string | null): Promise<void> {
  for (const userId of markedUsers()) {
    if (userId !== currentUserId) await forgetKeysOf(userId);
  }
}
