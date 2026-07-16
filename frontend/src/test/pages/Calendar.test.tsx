import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CalendarPage from '@/pages/Calendar';

const mocks = vi.hoisted(() => ({
  useNewEpisodes: vi.fn(),
  useUpcomingReleases: vi.fn(),
  setPlanned: vi.fn(),
  markWatched: vi.fn(),
  updatePreferences: vi.fn(),
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@/hooks/useCalendar', () => ({
  localDateKey: () => '2026-07-14',
  useCalendarSummary: () => ({
    data: { new_count: 2, planned_count: 1, last_synced_at: '2026-07-14T10:00:00Z' },
  }),
  useNewEpisodes: (...args: unknown[]) => mocks.useNewEpisodes(...args),
  useUpcomingReleases: (...args: unknown[]) => mocks.useUpcomingReleases(...args),
  useCalendarPreferences: () => ({
    data: { country_code: 'RO' },
    isLoading: false,
  }),
  useUpdateCalendarPreferences: () => ({
    mutate: mocks.updatePreferences,
    isPending: false,
    variables: undefined,
  }),
  useSetEpisodePlanned: () => ({
    mutate: mocks.setPlanned,
    isPending: false,
    variables: undefined,
    error: null,
  }),
  useMarkCalendarEpisodeWatched: () => ({
    mutate: mocks.markWatched,
    isPending: false,
    variables: undefined,
    error: null,
  }),
}));

function queryResult<T>(items: T[]) {
  return {
    data: { pages: [{ items, next_cursor: null, country_code: 'RO' }] },
    isLoading: false,
    isError: false,
    refetch: mocks.refetch,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
  };
}

const plannedEpisode = {
  episode_id: 'episode-planned',
  media_id: 'media-one',
  tmdb_id: 101,
  title: 'Tracked Show',
  poster_path: '/poster.jpg',
  season_number: 2,
  episode_number: 4,
  episode_name: 'Saved Episode',
  overview: null,
  runtime_minutes: 48,
  air_date: '2026-06-01',
  still_path: '/still.jpg',
  is_planned: true,
};

const todayEpisode = {
  ...plannedEpisode,
  episode_id: 'episode-today',
  episode_number: 5,
  episode_name: 'Today Episode',
  air_date: '2026-07-14',
  is_planned: false,
};

const upcomingMovie = {
  item_kind: 'movie',
  item_id: 'movie-one',
  media_id: 'movie-one',
  tmdb_id: 202,
  title: 'Upcoming Movie',
  poster_path: '/movie.jpg',
  release_date: '2026-07-20',
  release_type: 3,
  season_number: null,
  episode_number: null,
  episode_name: null,
  still_path: null,
  is_planned: false,
};

describe('Calendar page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useNewEpisodes.mockReturnValue(queryResult([plannedEpisode, todayEpisode]));
    mocks.useUpcomingReleases.mockReturnValue(queryResult([upcomingMovie]));
  });

  it('groups planned and fresh episodes and exposes direct actions', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CalendarPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Watch next' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.getByText('S02E04')).toBeVisible();
    expect(screen.getByText('S02E05')).toBeVisible();

    await user.click(screen.getByRole('button', {
      name: 'Remove Saved Episode from Watch next',
    }));
    expect(mocks.setPlanned).toHaveBeenCalledWith({
      episodeId: 'episode-planned',
      planned: false,
    });

    await user.click(screen.getByRole('button', { name: 'Mark Today Episode watched' }));
    expect(mocks.markWatched).toHaveBeenCalledWith('episode-today');
  });

  it('switches to upcoming filters and updates the release region', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CalendarPage /></MemoryRouter>);

    await user.click(screen.getByRole('tab', { name: 'Upcoming' }));
    expect(screen.getByText('Upcoming Movie')).toBeVisible();
    expect(screen.getByText('Cinema')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Movies' }));
    expect(mocks.useUpcomingReleases).toHaveBeenLastCalledWith('movie', false, true);

    await user.selectOptions(screen.getByLabelText('Release region'), 'US');
    expect(mocks.updatePreferences).toHaveBeenCalledWith('US');
  });

  it('loads the next backlog page when the list end approaches the viewport', async () => {
    mocks.useNewEpisodes.mockReturnValue({
      ...queryResult([todayEpisode]),
      hasNextPage: true,
    });
    vi.stubGlobal('IntersectionObserver', class {
      private readonly callback: IntersectionObserverCallback;

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }

      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    });

    render(<MemoryRouter><CalendarPage /></MemoryRouter>);

    await waitFor(() => expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });
});
