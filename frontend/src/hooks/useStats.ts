import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type { UserStats, HeatmapDay, GenreDistribution, MonthlyActivity } from '@/types';

export function useMyStats() {
  return useQuery<UserStats>({
    queryKey: ['stats', 'me'],
    queryFn: async () => {
      const res = await api.get('/stats/me');
      return res.data;
    },
  });
}

export function useHeatmap(year?: number) {
  return useQuery<HeatmapDay[]>({
    queryKey: ['stats', 'heatmap', year],
    queryFn: async () => {
      const params = year ? { year: String(year) } : {};
      const res = await api.get('/stats/me/heatmap', { params });
      return res.data;
    },
  });
}

export function useGenreDistribution() {
  return useQuery<GenreDistribution[]>({
    queryKey: ['stats', 'genres'],
    queryFn: async () => {
      const res = await api.get('/stats/me/genres');
      return res.data;
    },
  });
}

export function useMonthlyActivity() {
  return useQuery<MonthlyActivity[]>({
    queryKey: ['stats', 'monthly'],
    queryFn: async () => {
      const res = await api.get('/stats/me/monthly');
      return res.data;
    },
  });
}
