import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  CalendarEpisodePage,
  CalendarPreferences,
  CalendarSummary,
  CalendarWatchResponse,
  EpisodeCursor,
  UpNextResponse,
  UpcomingCalendarPage,
  UpcomingCursor,
} from '@/types';

const PAGE_LIMIT = 50;

export const calendarKeys = {
  all: ['calendar'] as const,
  summary: (today: string) => ['calendar', 'summary', today] as const,
  upNext: (today: string, limit: number, includeSpecials: boolean) =>
    ['calendar', 'up-next', today, limit, includeSpecials] as const,
  new: (today: string, includeSpecials: boolean) =>
    ['calendar', 'new', today, includeSpecials] as const,
  upcoming: (today: string, itemType: string, includeSpecials: boolean) =>
    ['calendar', 'upcoming', today, itemType, includeSpecials] as const,
  preferences: ['calendar', 'preferences'] as const,
};

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useCalendarSummary(enabled = true) {
  const today = localDateKey();
  return useQuery<CalendarSummary>({
    queryKey: calendarKeys.summary(today),
    queryFn: async () => {
      const response = await api.get<CalendarSummary>('/calendar/summary', {
        params: { today },
      });
      return response.data;
    },
    enabled,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useUpNextEpisodes(
  limit = 6,
  includeSpecials = false,
  enabled = true,
) {
  const today = localDateKey();
  return useQuery<UpNextResponse>({
    queryKey: calendarKeys.upNext(today, limit, includeSpecials),
    queryFn: async () => {
      const response = await api.get<UpNextResponse>('/calendar/up-next', {
        params: {
          today,
          limit,
          include_specials: includeSpecials,
        },
      });
      return response.data;
    },
    enabled,
  });
}

export function useNewEpisodes(includeSpecials: boolean, enabled = true) {
  const today = localDateKey();
  return useInfiniteQuery({
    queryKey: calendarKeys.new(today, includeSpecials),
    queryFn: async ({ pageParam }): Promise<CalendarEpisodePage> => {
      const cursor = pageParam as EpisodeCursor | null;
      const response = await api.get<CalendarEpisodePage>('/calendar/new', {
        params: {
          today,
          limit: PAGE_LIMIT,
          include_specials: includeSpecials,
          ...(cursor && cursor),
        },
      });
      return response.data;
    },
    initialPageParam: null as EpisodeCursor | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled,
  });
}

export function useUpcomingReleases(
  itemType: 'all' | 'tv' | 'movie',
  includeSpecials: boolean,
  enabled = true,
) {
  const today = localDateKey();
  return useInfiniteQuery({
    queryKey: calendarKeys.upcoming(today, itemType, includeSpecials),
    queryFn: async ({ pageParam }): Promise<UpcomingCalendarPage> => {
      const cursor = pageParam as UpcomingCursor | null;
      const response = await api.get<UpcomingCalendarPage>('/calendar/upcoming', {
        params: {
          today,
          limit: PAGE_LIMIT,
          type: itemType,
          include_specials: includeSpecials,
          ...(cursor && cursor),
        },
      });
      return response.data;
    },
    initialPageParam: null as UpcomingCursor | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled,
  });
}

export function useCalendarPreferences(enabled = true) {
  return useQuery<CalendarPreferences>({
    queryKey: calendarKeys.preferences,
    queryFn: async () => {
      const response = await api.get<CalendarPreferences>('/calendar/preferences');
      return response.data;
    },
    enabled,
  });
}

export function useUpdateCalendarPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (countryCode: string) => {
      const response = await api.put<CalendarPreferences>('/calendar/preferences', {
        country_code: countryCode,
      });
      return response.data;
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData(calendarKeys.preferences, preferences);
      void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
    },
  });
}

export function useSetEpisodePlanned() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ episodeId, planned }: { episodeId: string; planned: boolean }) => {
      if (planned) {
        await api.put(`/calendar/episodes/${episodeId}/plan`);
      } else {
        await api.delete(`/calendar/episodes/${episodeId}/plan`);
      }
      return { episodeId, planned };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
  });
}

export function useMarkCalendarEpisodeWatched() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (episodeId: string) => {
      const response = await api.post<CalendarWatchResponse>(
        `/calendar/episodes/${episodeId}/watched`,
      );
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      void queryClient.invalidateQueries({ queryKey: ['tracking'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['activity'] });
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
    },
  });
}
