import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectEventStream } from '@/lib/events';
import { messageKeys } from '@/hooks/useMessages';
import { useAuthStore } from '@/store/auth';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

/**
 * Holds the server-sent event stream open for the signed-in session.
 *
 * Renders nothing; it exists so the stream's lifetime is tied to the
 * authenticated part of the tree, and so React tears it down on sign-out rather
 * than leaving a connection authenticated as somebody who has left.
 */
export function EventStream() {
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    if (status !== 'authenticated') return;

    const refetchMessages = () => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.all });
    };
    const refetchNotifications = () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };

    return connectEventStream(
      API_URL,
      // Read the token at connect time rather than closing over it: it rotates
      // every fifteen minutes, and a captured value would go stale and make
      // every reconnect fail.
      () => useAuthStore.getState().token,
      {
        onEvent: (kind) => {
          if (kind === 'messages') refetchMessages();
          else refetchNotifications();
        },
        // After any (re)connect the client cannot know what it missed, so it
        // refetches both areas rather than assuming nothing happened.
        onResync: () => {
          refetchMessages();
          refetchNotifications();
        },
      },
    );
    // `userId` is a dependency so switching accounts rebuilds the stream
    // instead of leaving one open for the previous session.
  }, [status, userId, queryClient]);

  return null;
}
