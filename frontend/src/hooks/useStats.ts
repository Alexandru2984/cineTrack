import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  UserStats,
  HeatmapDay,
  GenreDistribution,
  MonthlyActivity,
  WrappedStats,
} from '@/types';

/** Minutes to add to UTC to reach this device's civil time.
 *
 *  Sent with every statistic that buckets by day, because the server has no
 *  other way to know it: a watch at 00:30 in Bucharest is 21:30 the day before
 *  in Greenwich, and filing it there put two evenings on one square of the
 *  heatmap and broke streaks that were not broken.
 *
 *  `getTimezoneOffset` returns the opposite sign, and it is read per call
 *  rather than once, so a device that crosses a boundary — or a browser left
 *  open across a daylight-saving change — sends the offset that is true now.
 *  It is in the query key so the cached answer belongs to the offset it was
 *  fetched for. */
function utcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function useMyStats() {
  return useQuery<UserStats>({
    queryKey: ['stats', 'me', utcOffsetMinutes()],
    queryFn: async () => {
      const res = await api.get('/stats/me', {
        params: { utc_offset_minutes: String(utcOffsetMinutes()) },
      });
      return res.data;
    },
  });
}

export function useHeatmap(year?: number) {
  return useQuery<HeatmapDay[]>({
    queryKey: ['stats', 'heatmap', year, utcOffsetMinutes()],
    queryFn: async () => {
      const params: Record<string, string> = {
        utc_offset_minutes: String(utcOffsetMinutes()),
      };
      if (year) params.year = String(year);
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
    queryKey: ['stats', 'monthly', utcOffsetMinutes()],
    queryFn: async () => {
      const res = await api.get('/stats/me/monthly', {
        params: { utc_offset_minutes: String(utcOffsetMinutes()) },
      });
      return res.data;
    },
  });
}

export function useWrapped(year: number) {
  return useQuery<WrappedStats>({
    queryKey: ['stats', 'wrapped', year, utcOffsetMinutes()],
    queryFn: async () => {
      const res = await api.get('/stats/me/wrapped', {
        params: {
          year: String(year),
          utc_offset_minutes: String(utcOffsetMinutes()),
        },
      });
      return res.data;
    },
  });
}
