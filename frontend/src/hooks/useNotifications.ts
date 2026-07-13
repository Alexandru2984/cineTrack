import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import api from '@/lib/api';
import type { NotificationListResponse } from '@/types';

const SUMMARY_LIMIT = 5;
const PAGE_LIMIT = 20;

export const notificationKeys = {
  all: ['notifications'] as const,
  summary: ['notifications', 'summary'] as const,
  list: ['notifications', 'list'] as const,
};

interface NotificationCursor {
  before: string;
  beforeId: string;
}

async function fetchNotifications(
  limit: number,
  cursor: NotificationCursor | null = null,
): Promise<NotificationListResponse> {
  const response = await api.get<NotificationListResponse>('/notifications', {
    params: {
      limit,
      ...(cursor && { before: cursor.before, before_id: cursor.beforeId }),
    },
  });
  return response.data;
}

function updateOne(
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

function updateAll(response: NotificationListResponse, readAt: string): NotificationListResponse {
  return {
    ...response,
    unread_count: 0,
    items: response.items.map((item) =>
      item.read_at === null ? { ...item, read_at: readAt } : item,
    ),
  };
}

function isUnreadInCache(
  summary: NotificationListResponse | undefined,
  list: InfiniteData<NotificationListResponse> | undefined,
  id: string,
): boolean {
  return (
    summary?.items.some((item) => item.id === id && item.read_at === null) === true ||
    list?.pages.some((page) =>
      page.items.some((item) => item.id === id && item.read_at === null),
    ) === true
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

export function useNotificationSummary(enabled = true) {
  return useQuery<NotificationListResponse>({
    queryKey: notificationKeys.summary,
    queryFn: () => fetchNotifications(SUMMARY_LIMIT),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useNotifications(enabled = true) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list,
    queryFn: ({ pageParam }) => fetchNotifications(PAGE_LIMIT, pageParam),
    initialPageParam: null as NotificationCursor | null,
    getNextPageParam: (lastPage) => {
      const lastItem = lastPage.items.at(-1);
      if (!lastPage.has_more || !lastItem) return undefined;
      return { before: lastItem.created_at, beforeId: lastItem.id };
    },
    enabled,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/notifications/${id}/read`);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });
      const summary = queryClient.getQueryData<NotificationListResponse>(notificationKeys.summary);
      const list = queryClient.getQueryData<InfiniteData<NotificationListResponse>>(
        notificationKeys.list,
      );
      const decrementUnread = isUnreadInCache(summary, list, id);
      const readAt = new Date().toISOString();
      updateCachedResponses(queryClient, (response) =>
        updateOne(response, id, readAt, decrementUnread),
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
    mutationFn: async () => {
      const response = await api.post<{ updated: number }>('/notifications/read-all');
      return response.data;
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.all });
      const summary = queryClient.getQueryData<NotificationListResponse>(notificationKeys.summary);
      const list = queryClient.getQueryData<InfiniteData<NotificationListResponse>>(
        notificationKeys.list,
      );
      const readAt = new Date().toISOString();
      updateCachedResponses(queryClient, (response) => updateAll(response, readAt));
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
