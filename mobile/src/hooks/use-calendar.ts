import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type {
  CalendarEpisodePage,
  CalendarSummary,
  CalendarWatchResponse,
  EpisodeCursor,
  UpcomingCalendarPage,
  UpcomingCursor,
  UpNextResponse,
} from '@/types';

const PAGE_LIMIT = 50;

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const calendarKeys = {
  all: ['calendar'] as const,
  summary: (today: string) => ['calendar', 'summary', today] as const,
  upNext: (today: string, limit: number) => ['calendar', 'up-next', today, limit] as const,
  new: (today: string, includeSpecials: boolean) =>
    ['calendar', 'new', today, includeSpecials] as const,
  upcoming: (today: string, type: string, includeSpecials: boolean) =>
    ['calendar', 'upcoming', today, type, includeSpecials] as const,
};

export function useCalendarSummary() {
  const today = localDateKey();
  return useQuery({
    queryKey: calendarKeys.summary(today),
    queryFn: () =>
      apiRequest<CalendarSummary>(withQuery('/calendar/summary', { today })),
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useUpNext(limit = 10) {
  const today = localDateKey();
  return useQuery({
    queryKey: calendarKeys.upNext(today, limit),
    queryFn: () =>
      apiRequest<UpNextResponse>(
        withQuery('/calendar/up-next', {
          today,
          limit,
          include_specials: false,
        }),
      ),
  });
}

export function useNewEpisodes(includeSpecials: boolean, enabled: boolean) {
  const today = localDateKey();
  return useInfiniteQuery({
    queryKey: calendarKeys.new(today, includeSpecials),
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as EpisodeCursor | null;
      return apiRequest<CalendarEpisodePage>(
        withQuery('/calendar/new', {
          today,
          limit: PAGE_LIMIT,
          include_specials: includeSpecials,
          ...cursor,
        }),
      );
    },
    initialPageParam: null as EpisodeCursor | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled,
  });
}

export function useUpcoming(
  type: 'all' | 'tv' | 'movie',
  includeSpecials: boolean,
  enabled: boolean,
) {
  const today = localDateKey();
  return useInfiniteQuery({
    queryKey: calendarKeys.upcoming(today, type, includeSpecials),
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as UpcomingCursor | null;
      return apiRequest<UpcomingCalendarPage>(
        withQuery('/calendar/upcoming', {
          today,
          limit: PAGE_LIMIT,
          type,
          include_specials: includeSpecials,
          ...cursor,
        }),
      );
    },
    initialPageParam: null as UpcomingCursor | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled,
  });
}

export function useSetEpisodePlanned() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ episodeId, planned }: { episodeId: string; planned: boolean }) =>
      apiRequest(`/calendar/episodes/${episodeId}/plan`, {
        method: planned ? 'PUT' : 'DELETE',
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
  });
}

export function useMarkCalendarEpisodeWatched() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (episodeId: string) =>
      apiRequest<CalendarWatchResponse>(`/calendar/episodes/${episodeId}/watched`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['tracking'] }),
        queryClient.invalidateQueries({ queryKey: ['stats'] }),
        queryClient.invalidateQueries({ queryKey: ['discovery'] }),
        queryClient.invalidateQueries({ queryKey: ['watched-episodes'] }),
        queryClient.invalidateQueries({ queryKey: ['show-progress'] }),
      ]);
    },
  });
}
