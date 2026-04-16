import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { TmdbSearchResponse, TmdbSearchResult } from '@/types';

export function useSearch(query: string, type?: string, page = 1) {
  return useQuery<TmdbSearchResponse>({
    queryKey: ['search', query, type, page],
    queryFn: async () => {
      const params: Record<string, string> = { q: query, page: String(page) };
      if (type) params.type = type;
      const res = await api.get('/media/search', { params });
      return res.data;
    },
    enabled: query.length > 0,
  });
}

export function useTrending() {
  return useQuery<{ results: TmdbSearchResult[] }>({
    queryKey: ['trending'],
    queryFn: async () => {
      const res = await api.get('/media/trending');
      return res.data;
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useMediaDetail(id: string, type: string) {
  return useQuery({
    queryKey: ['media', id, type],
    queryFn: async () => {
      const res = await api.get(`/media/${id}`, { params: { type } });
      return res.data;
    },
    enabled: !!id,
  });
}

export function useSeasons(id: string) {
  return useQuery({
    queryKey: ['seasons', id],
    queryFn: async () => {
      const res = await api.get(`/media/${id}/seasons`);
      return res.data;
    },
    enabled: !!id,
  });
}

export function useEpisodes(id: string, seasonNumber: number) {
  return useQuery({
    queryKey: ['episodes', id, seasonNumber],
    queryFn: async () => {
      const res = await api.get(`/media/${id}/seasons/${seasonNumber}/episodes`);
      return res.data;
    },
    enabled: !!id && seasonNumber > 0,
  });
}
