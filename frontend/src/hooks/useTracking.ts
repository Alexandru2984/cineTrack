import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  BulkWatchResponse,
  HistoryItem,
  SeasonWatchProgress,
  TrackingItem,
  TrackingStatus,
} from '@/types';

export interface TrackingLookupTarget {
  tmdb_id: number;
  media_type: 'movie' | 'tv';
}

const TRACKING_LOOKUP_BATCH_SIZE = 100;

function trackingLookupBatches(
  targets: readonly TrackingLookupTarget[],
): TrackingLookupTarget[][] {
  const unique = new Map<string, TrackingLookupTarget>();
  for (const target of targets) {
    if (!Number.isInteger(target.tmdb_id) || target.tmdb_id <= 0) continue;
    unique.set(`${target.media_type}:${target.tmdb_id}`, target);
  }

  const items = Array.from(unique.values());
  const batches: TrackingLookupTarget[][] = [];
  for (let offset = 0; offset < items.length; offset += TRACKING_LOOKUP_BATCH_SIZE) {
    batches.push(items.slice(offset, offset + TRACKING_LOOKUP_BATCH_SIZE));
  }
  return batches;
}

function invalidateTrackingState(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void Promise.all([
    queryClient.invalidateQueries({ queryKey: ['tracking'] }),
    queryClient.invalidateQueries({ queryKey: ['stats'] }),
    queryClient.invalidateQueries({ queryKey: ['activity'] }),
    queryClient.invalidateQueries({ queryKey: ['discovery'] }),
    queryClient.invalidateQueries({ queryKey: ['calendar'] }),
    // Moving a show to `completed` fills in the watch history for every aired
    // episode server-side, so the episode list and the progress bars go stale
    // on a plain status change too. These are keyed by show and only the one
    // on screen is active, so invalidating the whole family costs a single
    // refetch at most.
    queryClient.invalidateQueries({ queryKey: ['watched-episodes'] }),
    queryClient.invalidateQueries({ queryKey: ['show-watch-progress'] }),
    queryClient.invalidateQueries({ queryKey: ['history'] }),
  ]);
}

function invalidateEpisodeWatchState(
  queryClient: ReturnType<typeof useQueryClient>,
  tmdbId: number,
) {
  void queryClient.invalidateQueries({ queryKey: ['watched-episodes', tmdbId] });
  void queryClient.invalidateQueries({ queryKey: ['show-watch-progress', tmdbId] });
  void queryClient.invalidateQueries({ queryKey: ['history'] });
  void queryClient.invalidateQueries({ queryKey: ['tracking'] });
  void queryClient.invalidateQueries({ queryKey: ['stats'] });
  void queryClient.invalidateQueries({ queryKey: ['activity'] });
  void queryClient.invalidateQueries({ queryKey: ['discovery'] });
  void queryClient.invalidateQueries({ queryKey: ['calendar'] });
}

export function useTrackingInfinite(status?: string) {
  return useInfiniteQuery({
    queryKey: ['tracking', status, 'infinite'],
    queryFn: async ({ pageParam }) => {
      const params = { ...(status && { status }), page: pageParam, limit: 100 };
      const res = await api.get('/tracking', { params });
      return res.data as TrackingItem[];
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === 100 ? pages.length + 1 : undefined,
  });
}

export function useTrackingLookup(
  tmdbId: number | undefined,
  mediaType: string | undefined,
) {
  return useQuery<TrackingItem | null>({
    queryKey: ['tracking', 'lookup', mediaType, tmdbId],
    queryFn: async () => {
      const response = await api.post<TrackingItem[]>('/tracking/lookup', {
        items: [{ tmdb_id: tmdbId, media_type: mediaType }],
      });
      return response.data[0] ?? null;
    },
    enabled:
      typeof tmdbId === 'number'
      && tmdbId > 0
      && (mediaType === 'movie' || mediaType === 'tv'),
  });
}

export function useTrackingLookupBatch(
  targets: readonly TrackingLookupTarget[],
) {
  const batches = trackingLookupBatches(targets);
  const lookupKey = batches.flatMap((batch) =>
    batch.map((item) => `${item.media_type}:${item.tmdb_id}`),
  );

  return useQuery<TrackingItem[]>({
    queryKey: ['tracking', 'lookup', 'batch', lookupKey],
    queryFn: async () => {
      const responses = await Promise.all(
        batches.map((items) =>
          api.post<TrackingItem[]>('/tracking/lookup', { items }),
        ),
      );
      return responses.flatMap((response) => response.data);
    },
    enabled: batches.length > 0,
  });
}

export function useCreateTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      tmdb_id: number;
      media_type: 'movie' | 'tv';
      status: TrackingStatus;
    }) => {
      const res = await api.post<TrackingItem>('/tracking', data);
      return res.data;
    },
    onSuccess: () => invalidateTrackingState(qc),
  });
}

export function useUpdateTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: string; status?: TrackingStatus; rating?: number | null; review?: string | null; is_favorite?: boolean }) => {
      const res = await api.patch(`/tracking/${id}`, data);
      return res.data;
    },
    onSuccess: () => invalidateTrackingState(qc),
  });
}

export function useDeleteTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/tracking/${id}`);
    },
    onSuccess: () => invalidateTrackingState(qc),
  });
}

export function useHistory() {
  return useQuery<HistoryItem[]>({
    queryKey: ['history'],
    queryFn: async () => {
      const res = await api.get('/history');
      return res.data;
    },
  });
}

export function useCreateHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { media_id: string; episode_id?: string }) => {
      const res = await api.post('/history', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['history'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

export function useWatchedEpisodes(tmdbId: number | undefined, seasonNumber: number | null) {
  return useQuery<number[]>({
    queryKey: ['watched-episodes', tmdbId, seasonNumber],
    queryFn: async () => {
      const res = await api.get(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes`
      );
      return res.data;
    },
    enabled: !!tmdbId && seasonNumber !== null && seasonNumber >= 0,
  });
}

export function useShowWatchProgress(tmdbId: number | undefined) {
  return useQuery<SeasonWatchProgress[]>({
    queryKey: ['show-watch-progress', tmdbId],
    queryFn: async () => {
      const res = await api.get(`/history/tv/${tmdbId}/progress`);
      return res.data;
    },
    enabled: !!tmdbId,
  });
}

export function useMarkEpisodeWatched() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tmdbId,
      seasonNumber,
      episodeNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
      episodeNumber: number;
    }) => {
      const res = await api.post(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes/${episodeNumber}/watched`
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      invalidateEpisodeWatchState(qc, variables.tmdbId);
    },
  });
}

/** Undo a watch. Mirrors useMarkEpisodeWatched, including the cache
 *  invalidation, so the episode list, the season progress and Up Next all
 *  settle on the same answer. */
export function useUnmarkEpisodeWatched() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tmdbId,
      seasonNumber,
      episodeNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
      episodeNumber: number;
    }) => {
      const res = await api.delete<{ removed_count: number }>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes/${episodeNumber}/watched`,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      invalidateEpisodeWatchState(qc, variables.tmdbId);
    },
  });
}

export function useMarkSeasonWatched() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tmdbId,
      seasonNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
    }) => {
      const res = await api.post<BulkWatchResponse>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/watched`,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      invalidateEpisodeWatchState(qc, variables.tmdbId);
    },
  });
}

export function useMarkEpisodesWatchedThrough() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tmdbId,
      seasonNumber,
      episodeNumber,
    }: {
      tmdbId: number;
      seasonNumber: number;
      episodeNumber: number;
    }) => {
      const res = await api.post<BulkWatchResponse>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/episodes/${episodeNumber}/watched-through`,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      invalidateEpisodeWatchState(qc, variables.tmdbId);
    },
  });
}
