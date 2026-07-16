import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { calendarKeys } from '@/hooks/use-calendar';
import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type {
  BulkWatchResponse,
  MediaType,
  SeasonWatchProgress,
  TrackingItem,
  TrackingStatus,
} from '@/types';

async function invalidateWatchState(
  queryClient: ReturnType<typeof useQueryClient>,
  tmdbId: number,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['watched-episodes', tmdbId] }),
    queryClient.invalidateQueries({ queryKey: ['show-progress', tmdbId] }),
    queryClient.invalidateQueries({ queryKey: ['tracking'] }),
    queryClient.invalidateQueries({ queryKey: ['stats'] }),
    queryClient.invalidateQueries({ queryKey: ['discovery'] }),
    queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
  ]);
}

export function useTracking(status?: TrackingStatus) {
  return useQuery({
    queryKey: ['tracking', status],
    queryFn: () =>
      apiRequest<TrackingItem[]>(
        withQuery('/tracking', { status, limit: 100 }),
      ),
  });
}

export function useTrackingInfinite(status?: TrackingStatus) {
  return useInfiniteQuery({
    queryKey: ['tracking', status, 'infinite'],
    queryFn: ({ pageParam }) =>
      apiRequest<TrackingItem[]>(
        withQuery('/tracking', { status, page: pageParam, limit: 100 }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === 100 ? pages.length + 1 : undefined,
  });
}

export function useCreateTracking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      tmdb_id: number;
      media_type: MediaType;
      status: TrackingStatus;
    }) => apiRequest<TrackingItem>('/tracking', { method: 'POST', body: data }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tracking'] }),
        queryClient.invalidateQueries({ queryKey: ['stats'] }),
        queryClient.invalidateQueries({ queryKey: ['discovery'] }),
        queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
      ]);
    },
  });
}

export function useUpdateTracking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      status?: TrackingStatus;
      is_favorite?: boolean;
    }) => apiRequest<TrackingItem>(`/tracking/${id}`, { method: 'PATCH', body: data }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tracking'] }),
        queryClient.invalidateQueries({ queryKey: ['stats'] }),
        queryClient.invalidateQueries({ queryKey: ['discovery'] }),
        queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
      ]);
    },
  });
}

export function useDeleteTracking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/tracking/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tracking'] }),
        queryClient.invalidateQueries({ queryKey: ['stats'] }),
        queryClient.invalidateQueries({ queryKey: ['discovery'] }),
        queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
      ]);
    },
  });
}

export function useWatchedEpisodes(tmdbId: number | undefined, seasonNumber: number | null) {
  return useQuery({
    queryKey: ['watched-episodes', tmdbId, seasonNumber],
    queryFn: () =>
      apiRequest<number[]>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes`,
      ),
    enabled: Boolean(tmdbId) && seasonNumber !== null && seasonNumber >= 0,
  });
}

export function useShowProgress(tmdbId: number | undefined) {
  return useQuery({
    queryKey: ['show-progress', tmdbId],
    queryFn: () =>
      apiRequest<SeasonWatchProgress[]>(`/history/tv/${tmdbId}/progress`),
    enabled: Boolean(tmdbId),
  });
}

export function useMarkEpisodeWatched() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tmdbId,
      seasonNumber,
      episodeNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
      episodeNumber: number;
    }) =>
      apiRequest(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes/${episodeNumber}/watched`,
        { method: 'POST' },
      ),
    onSuccess: (_data, variables) => invalidateWatchState(queryClient, variables.tmdbId),
  });
}

export function useMarkSeasonWatched() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tmdbId,
      seasonNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
    }) =>
      apiRequest<BulkWatchResponse>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/watched`,
        { method: 'POST' },
      ),
    onSuccess: (_data, variables) => invalidateWatchState(queryClient, variables.tmdbId),
  });
}

export function useMarkEpisodesWatchedThrough() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tmdbId,
      seasonNumber,
      episodeNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
      episodeNumber: number;
    }) =>
      apiRequest<BulkWatchResponse>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes/${episodeNumber}/watched-through`,
        { method: 'POST' },
      ),
    onSuccess: (_data, variables) => invalidateWatchState(queryClient, variables.tmdbId),
  });
}
