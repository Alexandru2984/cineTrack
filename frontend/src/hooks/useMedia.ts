import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  CommunityRating,
  DiscoveryResponse,
  Episode,
  EpisodeDetail,
  EpisodeReaction,
  Media,
  Season,
  TmdbSearchResponse,
  WatchProviders,
} from '@/types';

function preferredLanguage() {
  const language = typeof navigator === 'undefined' ? '' : navigator.language;
  return /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/.test(language) ? language : 'en-US';
}

export function useSearch(query: string, type?: string, page = 1) {
  const language = preferredLanguage();
  return useQuery<TmdbSearchResponse>({
    queryKey: ['search', query, type, page, language],
    queryFn: async () => {
      const params: Record<string, string> = { q: query, page: String(page), language };
      if (type) params.type = type;
      const res = await api.get('/media/search', { params });
      return res.data;
    },
    enabled: query.length >= 2,
  });
}

/** Tell the recommender a suggestion was wrong.
 *
 *  Invalidates discovery so the row refills without the dismissed title. The
 *  backend is idempotent, so a double tap while the list is refreshing is not
 *  an error. */
export function useDismissRecommendation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: { tmdb_id: number; media_type: string }) => {
      const type = item.media_type === 'tv' ? 'tv' : 'movie';
      await api.post(`/media/discovery/dismiss/${type}/${item.tmdb_id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}

export function useDiscovery() {
  const language = preferredLanguage();
  return useQuery<DiscoveryResponse>({
    queryKey: ['discovery', language],
    queryFn: async () => {
      const res = await api.get('/media/discovery', { params: { language } });
      return res.data;
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useMediaDetail(id: string, type: string) {
  const language = preferredLanguage();
  return useQuery<Media>({
    queryKey: ['media', id, type, language],
    queryFn: async () => {
      const res = await api.get(`/media/${id}`, { params: { type, language } });
      return res.data;
    },
    enabled: !!id,
  });
}

export function useWatchProviders(id: string, type: string, region?: string) {
  return useQuery<WatchProviders>({
    queryKey: ['watch-providers', id, type, region ?? 'default'],
    queryFn: async () => {
      const params: Record<string, string> = { type };
      if (region) params.region = region;
      const res = await api.get(`/media/${id}/watch-providers`, { params });
      return res.data;
    },
    enabled: !!id,
    staleTime: 60 * 60 * 1000,
  });
}

export function useCommunityRating(id: string, type: string) {
  return useQuery<CommunityRating>({
    queryKey: ['community-rating', id, type],
    queryFn: async () => {
      const res = await api.get(`/media/${id}/community-rating`, { params: { type } });
      return res.data;
    },
    enabled: !!id,
    // Aggregates move slowly; a member rating a title does not need to reflect
    // on every other viewer's page immediately.
    staleTime: 10 * 60 * 1000,
  });
}

export function useSeasons(id: string) {
  return useQuery<Season[]>({
    queryKey: ['seasons', id],
    queryFn: async () => {
      const res = await api.get(`/media/${id}/seasons`);
      return res.data;
    },
    enabled: !!id,
  });
}

export function useEpisodes(id: string, seasonNumber: number | null) {
  return useQuery<Episode[]>({
    queryKey: ['episodes', id, seasonNumber],
    queryFn: async () => {
      const res = await api.get(`/media/${id}/seasons/${seasonNumber}/episodes`);
      return res.data;
    },
    enabled: !!id && seasonNumber !== null && seasonNumber >= 0,
  });
}

export function useEpisodeDetail(id: string | undefined) {
  return useQuery<EpisodeDetail>({
    queryKey: ['episode', id],
    queryFn: async () => {
      const response = await api.get<EpisodeDetail>(`/media/episodes/${id}`);
      return response.data;
    },
    enabled: Boolean(id),
  });
}

/**
 * Set, change or clear the viewer's reaction to an episode. Passing null
 * removes it, which is what tapping the active reaction again does.
 */
export function useSetEpisodeReaction(episodeId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (reaction: EpisodeReaction | null) => {
      if (reaction === null) {
        await api.delete(`/media/episodes/${episodeId}/reaction`);
        return;
      }
      await api.put(`/media/episodes/${episodeId}/reaction`, { reaction });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
    },
  });
}
