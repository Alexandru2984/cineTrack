import {
  keepPreviousData,
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
  TrackingFacets,
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

export type LibrarySort = 'updated' | 'added' | 'title' | 'rating' | 'release';

/** The library's filters, as the screen's route and the API both spell them. */
export interface LibraryFilters {
  status?: TrackingStatus;
  mediaType?: MediaType;
  /** A TMDB genre id, or `anime`. */
  genre?: string;
  favorite?: boolean;
  q?: string;
  sort?: LibrarySort;
}

function libraryParams(filters: LibraryFilters) {
  return {
    status: filters.status,
    media_type: filters.mediaType,
    genre: filters.genre,
    favorite: filters.favorite ? 'true' : undefined,
    q: filters.q?.trim() || undefined,
    sort: filters.sort === 'updated' ? undefined : filters.sort,
  };
}

/** A query the offline cache should not keep for a week. `tracking` queries
 *  live as long as the cache does so the library opens offline; one per search
 *  term or genre would fill it with views nobody reopens. */
function isNarrowed(filters: LibraryFilters) {
  return Boolean(filters.mediaType || filters.genre || filters.favorite || filters.q?.trim());
}
const NARROWED_GC_TIME = 5 * 60 * 1000;

export function useTrackingInfinite(filters: LibraryFilters = {}, enabled = true) {
  const params = libraryParams(filters);
  const plain = !isNarrowed(filters) && !params.sort;
  return useInfiniteQuery({
    // A plain status view keeps the key it had before there were filters, so
    // the library saved for offline use by an earlier release still opens.
    queryKey: plain ? ['tracking', filters.status, 'infinite'] : ['tracking', 'infinite', params],
    queryFn: ({ pageParam }) =>
      apiRequest<TrackingItem[]>(
        withQuery('/tracking', { ...params, page: pageParam, limit: 100 }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === 100 ? pages.length + 1 : undefined,
    enabled,
    // The old list stays up while a new filter loads, instead of a spinner on
    // every keystroke.
    placeholderData: keepPreviousData,
    ...(isNarrowed(filters) && { gcTime: NARROWED_GC_TIME }),
  });
}

/** How many titles each choice of a filter would show, with the others as they
 *  are; see `tracking_facets` on the server. */
export function useTrackingFacets(filters: LibraryFilters, language: string, enabled = true) {
  const { sort: _sort, ...params } = libraryParams(filters);
  return useQuery({
    queryKey: ['tracking', 'facets', params, language],
    queryFn: () =>
      apiRequest<TrackingFacets>(withQuery('/tracking/facets', { ...params, language })),
    enabled,
    placeholderData: keepPreviousData,
    ...(isNarrowed(filters) && { gcTime: NARROWED_GC_TIME }),
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

/** Record another viewing.
 *
 *  Separate from the "watched" mutations rather than a flag on them: "watched"
 *  is idempotent so a double tap costs nothing, and this is additive by
 *  definition. One per level, matching the backend verbs.
 */
export function useRewatchSeason() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tmdbId, seasonNumber }: { tmdbId: number; seasonNumber: number }) =>
      apiRequest<BulkWatchResponse>(
        `/history/tv/${tmdbId}/seasons/${seasonNumber}/rewatch`,
        { method: 'POST' },
      ),
    onSuccess: (_data, variables) => invalidateWatchState(queryClient, variables.tmdbId),
  });
}

export function useRewatchShow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tmdbId }: { tmdbId: number }) =>
      apiRequest<BulkWatchResponse>(`/history/tv/${tmdbId}/rewatch`, { method: 'POST' }),
    onSuccess: (_data, variables) => invalidateWatchState(queryClient, variables.tmdbId),
  });
}

export function useRewatchMovie() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tmdbId }: { tmdbId: number }) =>
      apiRequest<{ times_watched: number }>(`/history/movies/${tmdbId}/rewatch`, {
        method: 'POST',
      }),
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
