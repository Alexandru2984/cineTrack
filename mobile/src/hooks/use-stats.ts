import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type {
  GenreDistribution,
  HeatmapDay,
  MonthlyActivity,
  UserStats,
} from '@/types';

const STATS_STALE_TIME = 60_000;

export function useMyStats(enabled = true) {
  return useQuery({
    queryKey: ['stats', 'me'],
    queryFn: () => apiRequest<UserStats>('/stats/me'),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}

export function useHeatmap(year: number, enabled = true) {
  return useQuery({
    queryKey: ['stats', 'heatmap', year],
    queryFn: () =>
      apiRequest<HeatmapDay[]>(withQuery('/stats/me/heatmap', { year })),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}

export function useGenreDistribution(enabled = true) {
  return useQuery({
    queryKey: ['stats', 'genres'],
    queryFn: () => apiRequest<GenreDistribution[]>('/stats/me/genres'),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}

export function useMonthlyActivity(enabled = true) {
  return useQuery({
    queryKey: ['stats', 'monthly'],
    queryFn: () => apiRequest<MonthlyActivity[]>('/stats/me/monthly'),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}
