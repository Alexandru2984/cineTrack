import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type {
  DiscoveryResponse,
  Episode,
  EpisodeDetail,
  Media,
  MediaType,
  Season,
  TmdbSearchResponse,
} from '@/types';

function preferredLanguage() {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/.test(locale) ? locale : 'en-US';
}

export function useMediaSearch(query: string, type?: MediaType) {
  const language = preferredLanguage();
  return useInfiniteQuery({
    queryKey: ['media-search', query, type, language],
    queryFn: ({ pageParam }) =>
      apiRequest<TmdbSearchResponse>(
        withQuery('/media/search', {
          q: query,
          page: pageParam,
          language,
          type,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < Math.min(lastPage.total_pages, 500) ? lastPage.page + 1 : undefined,
    enabled: query.length >= 2,
  });
}

export function useDiscovery() {
  const language = preferredLanguage();
  return useQuery({
    queryKey: ['discovery', language],
    queryFn: () =>
      apiRequest<DiscoveryResponse>(
        withQuery('/media/discovery', { language }),
      ),
    staleTime: 10 * 60 * 1000,
  });
}

export function useMediaDetail(id: string, type: MediaType) {
  const language = preferredLanguage();
  return useQuery({
    queryKey: ['media', id, type, language],
    queryFn: () =>
      apiRequest<Media>(
        withQuery(`/media/${id}`, { type, language }),
      ),
    enabled: Boolean(id),
  });
}

export function useSeasons(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['seasons', id],
    queryFn: () => apiRequest<Season[]>(`/media/${id}/seasons`),
    enabled: Boolean(id) && enabled,
  });
}

export function useEpisodes(id: string, seasonNumber: number | null) {
  return useQuery({
    queryKey: ['episodes', id, seasonNumber],
    queryFn: () =>
      apiRequest<Episode[]>(`/media/${id}/seasons/${seasonNumber}/episodes`),
    enabled: Boolean(id) && seasonNumber !== null && seasonNumber >= 0,
  });
}

export function useEpisodeDetail(id: string) {
  return useQuery({
    queryKey: ['episode', id],
    queryFn: () => apiRequest<EpisodeDetail>(`/media/episodes/${id}`),
    enabled: Boolean(id),
  });
}
