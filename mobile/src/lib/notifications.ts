import type {
  NotificationKind,
  NotificationListResponse,
  SocialNotification,
} from '@/types';

export interface NotificationCursor {
  before: string;
  beforeId: string;
}

export function notificationAction(kind: NotificationKind) {
  switch (kind) {
    case 'follow_request':
      return 'requested to follow you';
    case 'follow_accepted':
      return 'accepted your follow request';
    case 'new_follower':
      return 'started following you';
  }
}

export function nextNotificationCursor(
  page: NotificationListResponse,
): NotificationCursor | undefined {
  const lastItem = page.items.at(-1);
  if (!page.has_more || !lastItem) return undefined;
  return { before: lastItem.created_at, beforeId: lastItem.id };
}

export function uniqueNotifications(
  pages: readonly NotificationListResponse[],
): SocialNotification[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  );
}

export function markNotificationReadInResponse(
  response: NotificationListResponse,
  id: string,
  readAt: string,
  decrementUnread: boolean,
): NotificationListResponse {
  return {
    ...response,
    unread_count: decrementUnread
      ? Math.max(0, response.unread_count - 1)
      : response.unread_count,
    items: response.items.map((item) =>
      item.id === id && item.read_at === null ? { ...item, read_at: readAt } : item,
    ),
  };
}

export function markAllNotificationsReadInResponse(
  response: NotificationListResponse,
  readAt: string,
): NotificationListResponse {
  return {
    ...response,
    unread_count: 0,
    items: response.items.map((item) =>
      item.read_at === null ? { ...item, read_at: readAt } : item,
    ),
  };
}
