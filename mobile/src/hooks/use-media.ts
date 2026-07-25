import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocales } from 'expo-localization';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import { mediaLanguageFromLocales } from '@/lib/locale';
import type {
  EpisodeReaction,
  DiscoveryResponse,
  Episode,
  EpisodeDetail,
  Media,
  MediaType,
  Season,
  TmdbSearchResponse,
} from '@/types';
import { fetchWatchProviders } from '@/lib/watch-providers';

function usePreferredLanguage() {
  return mediaLanguageFromLocales(useLocales());
}

export function useMediaSearch(query: string, type?: MediaType) {
  const language = usePreferredLanguage();
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
  const language = usePreferredLanguage();
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
  const language = usePreferredLanguage();
  return useQuery({
    queryKey: ['media', id, type, language],
    queryFn: () =>
      apiRequest<Media>(
        withQuery(`/media/${id}`, { type, language }),
      ),
    enabled: Boolean(id),
  });
}

export function useWatchProviders(id: string, type: MediaType) {
  return useQuery({
    queryKey: ['watch-providers', id, type],
    queryFn: () => fetchWatchProviders(id, type),
    enabled: Boolean(id),
    staleTime: 60 * 60 * 1000,
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

/**
 * Set, change or clear the viewer's reaction. Passing null removes it, which is
 * what tapping the active reaction again does.
 */
export function useSetEpisodeReaction(episodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reaction: EpisodeReaction | null) =>
      reaction === null
        ? apiRequest(`/media/episodes/${episodeId}/reaction`, { method: 'DELETE' })
        : apiRequest(`/media/episodes/${episodeId}/reaction`, {
            method: 'PUT',
            body: { reaction },
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
    },
  });
}
