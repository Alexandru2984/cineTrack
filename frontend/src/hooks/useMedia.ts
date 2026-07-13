import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  DiscoveryResponse,
  Episode,
  Media,
  Season,
  TmdbSearchResponse,
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
    enabled: query.length > 0,
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
