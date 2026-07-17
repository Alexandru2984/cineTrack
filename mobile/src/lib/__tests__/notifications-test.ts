import {
  markAllNotificationsReadInResponse,
  markNotificationReadInResponse,
  nextNotificationCursor,
  notificationAction,
  uniqueNotifications,
} from '@/lib/notifications';
import type { NotificationListResponse, SocialNotification } from '@/types';

const first: SocialNotification = {
  id: 'notification-1',
  kind: 'follow_request',
  actor_id: 'actor-1',
  actor_username: 'alex',
  actor_avatar_url: null,
  read_at: null,
  created_at: '2026-07-17T10:00:00Z',
};

function response(
  items: SocialNotification[],
  unreadCount = items.filter((item) => item.read_at === null).length,
  hasMore = false,
): NotificationListResponse {
  return { items, unread_count: unreadCount, has_more: hasMore };
}

describe('mobile notifications', () => {
  it('formats every supported social event', () => {
    expect(notificationAction('follow_request')).toBe('requested to follow you');
    expect(notificationAction('follow_accepted')).toBe('accepted your follow request');
    expect(notificationAction('new_follower')).toBe('started following you');
  });

  it('uses the backend composite cursor and stops at the last page', () => {
    expect(nextNotificationCursor(response([first], 1, true))).toEqual({
      before: first.created_at,
      beforeId: first.id,
    });
    expect(nextNotificationCursor(response([first]))).toBeUndefined();
  });

  it('deduplicates items shared by summary and paginated data', () => {
    const second = { ...first, id: 'notification-2' };
    expect(uniqueNotifications([response([first]), response([first, second])])).toEqual([
      first,
      second,
    ]);
  });

  it('updates unread state without allowing negative counters', () => {
    const readAt = '2026-07-17T11:00:00Z';
    const updated = markNotificationReadInResponse(response([first]), first.id, readAt, true);
    expect(updated.unread_count).toBe(0);
    expect(updated.items[0].read_at).toBe(readAt);
    expect(
      markNotificationReadInResponse(updated, first.id, readAt, true).unread_count,
    ).toBe(0);
    expect(markAllNotificationsReadInResponse(response([first], 12), readAt)).toMatchObject({
      unread_count: 0,
      items: [{ read_at: readAt }],
    });
  });
});
