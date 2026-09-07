import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import { fetchWrapped } from '@/lib/wrapped';
import type {
  GenreDistribution,
  HeatmapDay,
  MonthlyActivity,
  UserStats,
} from '@/types';

const STATS_STALE_TIME = 60_000;

/** Minutes to add to UTC to reach this device's civil time.
 *
 *  Sent with every statistic that buckets by day. The server has no other way
 *  to know it: a watch at 00:30 in Bucharest is 21:30 the day before in
 *  Greenwich, and filing it there put two evenings on one square of the heatmap
 *  and broke streaks that were not broken.
 *
 *  Read per call rather than once, so a device that travels — or sits through a
 *  daylight-saving change — sends the offset that is true now, and it is part
 *  of the query key so a cached answer belongs to the offset it was fetched
 *  for. `release-notifications` computes the same value for push scheduling;
 *  this is deliberately not shared with it, because that one is stored on the
 *  server and this one must not be. */
function utcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function useMyStats(enabled = true) {
  return useQuery({
    queryKey: ['stats', 'me', utcOffsetMinutes()],
    queryFn: () =>
      apiRequest<UserStats>(
        withQuery('/stats/me', { utc_offset_minutes: utcOffsetMinutes() }),
      ),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}

export function useHeatmap(year: number, enabled = true) {
  return useQuery({
    queryKey: ['stats', 'heatmap', year, utcOffsetMinutes()],
    queryFn: () =>
      apiRequest<HeatmapDay[]>(
        withQuery('/stats/me/heatmap', {
          year,
          utc_offset_minutes: utcOffsetMinutes(),
        }),
      ),
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
    queryKey: ['stats', 'monthly', utcOffsetMinutes()],
    queryFn: () =>
      apiRequest<MonthlyActivity[]>(
        withQuery('/stats/me/monthly', { utc_offset_minutes: utcOffsetMinutes() }),
      ),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}

export function useWrapped(year: number, enabled = true) {
  return useQuery({
    queryKey: ['stats', 'wrapped', year],
    queryFn: () => fetchWrapped(year),
    staleTime: STATS_STALE_TIME,
    enabled,
  });
}
