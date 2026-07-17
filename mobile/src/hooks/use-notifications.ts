import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import {
  markAllNotificationsReadInResponse,
  markNotificationReadInResponse,
  nextNotificationCursor,
  type NotificationCursor,
} from '@/lib/notifications';
import type { NotificationListResponse } from '@/types';

const SUMMARY_LIMIT = 5;
const PAGE_LIMIT = 20;

export const notificationKeys = {
  all: ['notifications'] as const,
  summary: ['notifications', 'summary'] as const,
  list: ['notifications', 'list'] as const,
};

async function fetchNotifications(
  limit: number,
  cursor: NotificationCursor | null = null,
) {
  return apiRequest<NotificationListResponse>(
    withQuery('/notifications', {
      limit,
      before: cursor?.before,
      before_id: cursor?.beforeId,
    }),
  );
}

function updateCachedResponses(
  queryClient: QueryClient,
  update: (response: NotificationListResponse) => NotificationListResponse,
) {
  queryClient.setQueryData<NotificationListResponse>(notificationKeys.summary, (current) =>
    current ? update(current) : current,
  );
  queryClient.setQueryData<InfiniteData<NotificationListResponse>>(
    notificationKeys.list,
    (current) =>
      current
        ? { ...current, pages: current.pages.map((page) => update(page)) }
        : current,
  );
}

function isUnreadInCache(
  summary: NotificationListResponse | undefined,
  list: InfiniteData<NotificationListResponse> | undefined,
  id: string,
) {
  return (
    summary?.items.some((item) => item.id === id && item.read_at === null) === true ||
    list?.pages.some((page) =>
      page.items.some((item) => item.id === id && item.read_at === null),
    ) === true
  );
}

export function useNotificationSummary(enabled = true, poll = false) {
  return useQuery({
    queryKey: notificationKeys.summary,
    queryFn: () => fetchNotifications(SUMMARY_LIMIT),
    enabled,
    refetchInterval: poll ? 30_000 : false,
  });
}

export function useNotifications(enabled = true) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list,
    queryFn: ({ pageParam }) => fetchNotifications(PAGE_LIMIT, pageParam),
    initialPageParam: null as NotificationCursor | null,
    getNextPageParam: nextNotificationCursor,
    enabled,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/notifications/${id}/read`, { method: 'POST' }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });
      const summary = queryClient.getQueryData<NotificationListResponse>(
        notificationKeys.summary,
      );
      const list = queryClient.getQueryData<InfiniteData<NotificationListResponse>>(
        notificationKeys.list,
      );
      const decrementUnread = isUnreadInCache(summary, list, id);
      const readAt = new Date().toISOString();
      updateCachedResponses(queryClient, (response) =>
        markNotificationReadInResponse(response, id, readAt, decrementUnread),
      );
      return { summary, list };
    },
    onError: (_error, _id, context) => {
      if (!context) return;
      queryClient.setQueryData(notificationKeys.summary, context.summary);
      queryClient.setQueryData(notificationKeys.list, context.list);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/notifications/read-all', { method: 'POST' }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });
      const summary = queryClient.getQueryData<NotificationListResponse>(
        notificationKeys.summary,
      );
      const list = queryClient.getQueryData<InfiniteData<NotificationListResponse>>(
        notificationKeys.list,
      );
      const readAt = new Date().toISOString();
      updateCachedResponses(queryClient, (response) =>
        markAllNotificationsReadInResponse(response, readAt),
      );
      return { summary, list };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(notificationKeys.summary, context.summary);
      queryClient.setQueryData(notificationKeys.list, context.list);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
