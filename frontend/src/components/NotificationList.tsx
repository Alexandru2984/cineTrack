import { Link } from 'react-router-dom';
import { User } from 'lucide-react';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { formatDateTime } from '@/lib/utils';
import type { NotificationKind, SocialNotification } from '@/types';

interface NotificationListProps {
  items?: SocialNotification[];
  isLoading?: boolean;
  isError?: boolean;
  compact?: boolean;
  emptyMessage?: string;
  onRead?: (id: string) => void;
  onNavigate?: () => void;
}

function notificationAction(kind: NotificationKind): string {
  switch (kind) {
    case 'follow_request':
      return 'requested to follow you';
    case 'follow_accepted':
      return 'accepted your follow request';
    case 'new_follower':
      return 'started following you';
  }
}

function notificationDestination(notification: SocialNotification): string {
  if (notification.kind === 'follow_request') return '/settings#follow-requests';
  return `/profile/${encodeURIComponent(notification.actor_username)}`;
}

export function NotificationList({
  items,
  isLoading = false,
  isError = false,
  compact = false,
  emptyMessage = 'No notifications yet',
  onRead,
  onNavigate,
}: NotificationListProps) {
  if (isLoading) return <LoadingSpinner />;

  if (isError) {
    return (
      <p className="px-4 py-6 text-sm text-[hsl(var(--destructive))]" role="alert">
        Notifications could not be loaded
      </p>
    );
  }

  if (!items?.length) {
    return (
      <p className="px-4 py-6 text-sm text-[hsl(var(--muted-foreground))]">{emptyMessage}</p>
    );
  }

  return (
    <div className="divide-y divide-[hsl(var(--border))]">
      {items.map((notification) => {
        const isUnread = notification.read_at === null;
        return (
          <Link
            key={notification.id}
            to={notificationDestination(notification)}
            onClick={() => {
              if (isUnread) onRead?.(notification.id);
              onNavigate?.();
            }}
            className={`relative flex min-w-0 gap-3 transition-colors hover:bg-[hsl(var(--accent))]/60 ${
              compact ? 'px-4 py-3' : 'px-3 py-4 sm:px-4'
            } ${isUnread ? 'bg-[hsl(var(--accent))]/35' : ''}`}
          >
            <span
              className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[hsl(var(--muted))] ${
                compact ? 'h-9 w-9' : 'h-11 w-11'
              }`}
            >
              {notification.actor_avatar_url ? (
                <img
                  src={notification.actor_avatar_url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <User
                  className="h-5 w-5 text-[hsl(var(--muted-foreground))]"
                  aria-hidden="true"
                />
              )}
            </span>

            <span className="min-w-0 flex-1 self-center">
              <span className="block text-sm leading-5">
                <span className="break-words font-semibold">{notification.actor_username}</span>{' '}
                <span className="text-[hsl(var(--muted-foreground))]">
                  {notificationAction(notification.kind)}
                </span>
              </span>
              <time
                dateTime={notification.created_at}
                className="mt-1 block text-xs text-[hsl(var(--muted-foreground))]"
              >
                {formatDateTime(notification.created_at)}
              </time>
            </span>

            {isUnread && (
              <span
                className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--primary))]"
                aria-label="Unread"
              />
            )}
          </Link>
        );
      })}
    </div>
  );
}
