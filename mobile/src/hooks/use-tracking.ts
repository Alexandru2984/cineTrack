import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { calendarKeys } from '@/hooks/use-calendar';
import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import {
  buildTrackingLookupBatches,
  type TrackingLookupTarget,
} from '@/lib/tracking-lookup';
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

async function invalidateTrackingState(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['tracking'] }),
    queryClient.invalidateQueries({ queryKey: ['stats'] }),
    queryClient.invalidateQueries({ queryKey: ['discovery'] }),
    queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
    // Moving a show to `completed` fills in the watch history for every aired
    // episode server-side, so the episode list and the progress bars go stale
    // on a plain status change too. These are keyed by show and only the one
    // on screen is active, so invalidating the whole family costs a single
    // refetch at most.
    queryClient.invalidateQueries({ queryKey: ['watched-episodes'] }),
    queryClient.invalidateQueries({ queryKey: ['show-progress'] }),
  ]);
}

export function useTrackingLookup(targets: readonly TrackingLookupTarget[]) {
  const batches = buildTrackingLookupBatches(targets);
  const lookupKey = batches.flatMap((batch) =>
    batch.map((item) => `${item.media_type}:${item.tmdb_id}`),
  );

  return useQuery({
    queryKey: ['tracking', 'lookup', lookupKey],
    queryFn: async () => {
      const pages = await Promise.all(
        batches.map((items) =>
          apiRequest<TrackingItem[]>('/tracking/lookup', {
            method: 'POST',
            body: { items },
          }),
        ),
      );
      return pages.flat();
    },
    enabled: batches.length > 0,
  });
}

export function useTrackingInfinite(status?: TrackingStatus, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['tracking', status, 'infinite'],
    queryFn: ({ pageParam }) =>
      apiRequest<TrackingItem[]>(
        withQuery('/tracking', { status, page: pageParam, limit: 100 }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === 100 ? pages.length + 1 : undefined,
    enabled,
  });
}

/**
 * The watchlist shelf on the home screen.
 *
 * Kept separate from `useTrackingInfinite` because that hook pages in hundreds
 * of rows for a screen that lists them all, and a shelf shows a handful. The
 * key stays under `['tracking']` so every existing invalidation reaches it.
 */
export function useWatchlistPreview(limit = 12) {
  return useQuery({
    queryKey: ['tracking', 'plan_to_watch', 'preview', limit],
    queryFn: () =>
      apiRequest<TrackingItem[]>(
        withQuery('/tracking', { status: 'plan_to_watch', page: 1, limit }),
      ),
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
    onSuccess: () => invalidateTrackingState(queryClient),
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
      rating?: number | null;
      review?: string | null;
      is_favorite?: boolean;
    }) => apiRequest<TrackingItem>(`/tracking/${id}`, { method: 'PATCH', body: data }),
    onSuccess: () => invalidateTrackingState(queryClient),
  });
}

export function useDeleteTracking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/tracking/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateTrackingState(queryClient),
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
