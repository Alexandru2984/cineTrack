import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { calendarKeys } from '@/hooks/use-calendar';
import { apiRequest } from '@/lib/api';
import { HISTORY_PAGE_LIMIT } from '@/lib/history';
import { withQuery } from '@/lib/http';
import type { HistoryItem } from '@/types';

export const historyKeys = {
  all: ['history'] as const,
  list: ['history', 'list'] as const,
};

function invalidateHistoryState(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: historyKeys.all }),
    queryClient.invalidateQueries({ queryKey: ['stats'] }),
    queryClient.invalidateQueries({ queryKey: ['social'] }),
    queryClient.invalidateQueries({ queryKey: ['tracking'] }),
    queryClient.invalidateQueries({ queryKey: ['watched-episodes'] }),
    queryClient.invalidateQueries({ queryKey: ['show-progress'] }),
    queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
  ]);
}

export function useHistory(enabled = true) {
  return useInfiniteQuery({
    queryKey: historyKeys.list,
    queryFn: ({ pageParam }) =>
      apiRequest<HistoryItem[]>(
        withQuery('/history', {
          page: pageParam,
          limit: HISTORY_PAGE_LIMIT,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === HISTORY_PAGE_LIMIT ? pages.length + 1 : undefined,
    enabled,
  });
}

export function useCreateHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      mediaId,
      episodeId,
      watchedAt,
    }: {
      mediaId: string;
      episodeId?: string;
      watchedAt: string;
    }) =>
      apiRequest('/history', {
        method: 'POST',
        body: {
          media_id: mediaId,
          episode_id: episodeId,
          watched_at: watchedAt,
        },
      }),
    onSuccess: () => invalidateHistoryState(queryClient),
  });
}

export function useDeleteHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/history/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateHistoryState(queryClient),
  });
}
