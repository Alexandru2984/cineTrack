import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type { TrackingItem, HistoryItem } from '@/types';

export function useTracking(status?: string) {
  return useQuery<TrackingItem[]>({
    queryKey: ['tracking', status],
    queryFn: async () => {
      const params = status ? { status } : {};
      const res = await api.get('/tracking', { params });
      return res.data;
    },
  });
}

export function useCreateTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { tmdb_id: number; media_type: string; status: string }) => {
      const res = await api.post('/tracking', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tracking'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}

export function useUpdateTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: string; status?: string; rating?: number; review?: string; is_favorite?: boolean }) => {
      const res = await api.patch(`/tracking/${id}`, data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tracking'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}

export function useDeleteTracking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/tracking/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tracking'] });
      qc.invalidateQueries({ queryKey: ['discovery'] });
    },
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
      void qc.invalidateQueries({
        queryKey: ['watched-episodes', variables.tmdbId, variables.seasonNumber],
      });
      void qc.invalidateQueries({ queryKey: ['history'] });
      void qc.invalidateQueries({ queryKey: ['tracking'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}
