import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { connectEventStream } from '@/lib/events';
import { messageKeys } from '@/hooks/use-messages';
import { notificationKeys } from '@/hooks/use-notifications';
import { useAuthStore } from '@/store/auth';

/**
 * Hold the event stream open while the app is signed in and in the foreground.
 *
 * Foreground-only, and that is the real difference from the web client. iOS
 * suspends network activity behind the app switcher, so a connection held there
 * delivers nothing while still occupying a socket and waking the radio on every
 * retry. Reconnecting on resume costs one request; holding on costs battery for
 * messages that cannot arrive.
 *
 * Dropping the stream also means the client has a gap it cannot see, which is
 * exactly what the stream's resync signal is for: coming back to the foreground
 * refetches rather than assuming nothing happened while away.
 */
export function useEventStream() {
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    if (status !== 'authenticated') return;

    const refetchMessages = () => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.all });
    };
    const refetchNotifications = () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    };

    let disconnect: (() => void) | null = null;

    const open = () => {
      if (disconnect) return;
      disconnect = connectEventStream(
        // Read at connect time rather than closing over it: the access token
        // rotates, and a captured value would go stale and fail every
        // reconnect.
        () => useAuthStore.getState().accessToken,
        {
          onEvent: (kind) => {
            if (kind === 'messages') refetchMessages();
            else refetchNotifications();
          },
          onResync: () => {
            refetchMessages();
            refetchNotifications();
          },
        },
      );
    };

    const close = () => {
      disconnect?.();
      disconnect = null;
    };

    if (AppState.currentState === 'active') open();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') open();
      else close();
    });

    return () => {
      subscription.remove();
      close();
    };
    // `userId` is a dependency so switching accounts rebuilds the stream rather
    // than leaving one open for the previous session.
  }, [status, userId, queryClient]);
}
