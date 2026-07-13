import { CheckCheck, Loader2 } from 'lucide-react';
import { NotificationList } from '@/components/NotificationList';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationSummary,
  useNotifications,
} from '@/hooks/useNotifications';
import { getApiErrorMessage } from '@/lib/api';
import type { SocialNotification } from '@/types';

function uniqueNotifications(pages: { items: SocialNotification[] }[] | undefined) {
  const seen = new Set<string>();
  return (pages ?? []).flatMap((page) =>
    page.items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  );
}

export default function NotificationsPage() {
  const notifications = useNotifications();
  const summary = useNotificationSummary();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const items = uniqueNotifications([
    ...(summary.data ? [summary.data] : []),
    ...(notifications.data?.pages ?? []),
  ]);
  const unreadCount =
    summary.data?.unread_count ?? notifications.data?.pages[0]?.unread_count ?? 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]" aria-live="polite">
            {unreadCount === 0
              ? 'You are all caught up.'
              : `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`}
          </p>
        </div>
        <button
          type="button"
          disabled={unreadCount === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
          className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 py-2 text-sm font-medium transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {markAllRead.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
          )}
          Mark all as read
        </button>
      </div>

      <section
        className="mt-6 overflow-hidden border-y border-[hsl(var(--border))]"
        aria-label="Notification history"
      >
        <NotificationList
          items={items}
          isLoading={notifications.isLoading && summary.isLoading}
          isError={notifications.isError && summary.isError}
          onRead={(id) => markRead.mutate(id)}
        />
      </section>

      {notifications.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            disabled={notifications.isFetchingNextPage}
            onClick={() => notifications.fetchNextPage()}
            className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm font-medium transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            {notifications.isFetchingNextPage && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Load older notifications
          </button>
        </div>
      )}

      {(markRead.error || markAllRead.error) && (
        <p className="mt-4 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(
            markRead.error ?? markAllRead.error,
            'Could not update notifications',
          )}
        </p>
      )}
    </main>
  );
}
