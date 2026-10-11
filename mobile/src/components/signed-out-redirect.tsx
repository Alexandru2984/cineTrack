import { Redirect } from 'expo-router';

import { ErrorState, LoadingState } from '@/components/screen-state';
import { useT } from '@/hooks/use-t';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, type AuthStatus } from '@/store/auth';

/** Where a screen goes when it finds no session.
 *
 *  Never `/`. Both `app/index.tsx` and `app/(tabs)/index.tsx` answer to `/`,
 *  and from inside the tabs Expo Router resolves it to the tab. A signed-out
 *  guard in the tabs layout that redirected to `/` therefore redirected into
 *  itself: signing out, or losing the session to a password change elsewhere,
 *  froze the app in a render loop ("Maximum update depth exceeded"). The
 *  destinations are named explicitly so there is nothing left to resolve. */
export const SIGNED_OUT_ROUTE = '/(auth)/login' as const;
export const SIGNED_IN_HOME_ROUTE = '/(tabs)' as const;

/** Rendered by a guarded screen that cannot show itself for this session.
 *
 *  `/` used to decide this, through `app/index.tsx`; each case is now decided
 *  here instead, with the same outcomes:
 *  - still restoring: wait;
 *  - a session that exists but could not be restored (usually no network at
 *    launch): offer a retry, since the credentials are still on the device;
 *  - a session this screen cannot use, such as offline on a screen that needs
 *    the network: go home, not to the sign-in form;
 *  - no session: sign in. */
export function SignedOutRedirect({ status }: { status: AuthStatus }) {
  const t = useT();
  if (status === 'loading') return <LoadingState label={t('session.restoring')} />;
  if (status === 'restore_error') {
    return <ErrorState message={t('session.restoreError')} onRetry={() => void hydrateSession()} />;
  }
  if (hasLocalSession(status)) return <Redirect href={SIGNED_IN_HOME_ROUTE} />;
  return <Redirect href={SIGNED_OUT_ROUTE} />;
}
