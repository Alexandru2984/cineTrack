import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaDetail from '@/pages/MediaDetail';

const mocks = vi.hoisted(() => ({
  useEpisodes: vi.fn(),
  useWatchedEpisodes: vi.fn(),
  useShowWatchProgress: vi.fn(),
  createTracking: vi.fn(),
  markEpisodeWatched: vi.fn(),
  markSeasonWatched: vi.fn(),
  markEpisodesWatchedThrough: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: '1399' }),
  useSearchParams: () => [new URLSearchParams('type=tv')],
}));

vi.mock('@/hooks/useMedia', () => ({
  useMediaDetail: () => ({
    data: {
      id: '1399',
      tmdb_id: 1399,
      media_type: 'tv',
      title: 'Test Show',
      original_title: null,
      overview: 'A test overview.',
      poster_path: null,
      backdrop_path: null,
      release_date: '2020-01-01',
      status: 'Returning Series',
      genres: [],
      runtime_minutes: 45,
      vote_average: 8.2,
    },
    isLoading: false,
  }),
  useSeasons: () => ({
    data: [
      { id: 'specials', season_number: 0, name: 'Specials', episode_count: 1, air_date: null },
      { id: 'season-1', season_number: 1, name: 'Season 1', episode_count: 2, air_date: null },
      { id: 'season-2', season_number: 2, name: 'Season 2', episode_count: 2, air_date: null },
    ],
  }),
  useEpisodes: (...args: unknown[]) => mocks.useEpisodes(...args),
}));

vi.mock('@/hooks/useTracking', () => ({
  useCreateTracking: () => ({
    mutate: mocks.createTracking,
    isPending: false,
    error: null,
  }),
  useWatchedEpisodes: (...args: unknown[]) => mocks.useWatchedEpisodes(...args),
  useShowWatchProgress: (...args: unknown[]) => mocks.useShowWatchProgress(...args),
  useMarkEpisodeWatched: () => ({
    mutate: mocks.markEpisodeWatched,
    isPending: false,
    error: null,
  }),
  useMarkSeasonWatched: () => ({
    mutate: mocks.markSeasonWatched,
    isPending: false,
    error: null,
  }),
  useMarkEpisodesWatchedThrough: () => ({
    mutate: mocks.markEpisodesWatchedThrough,
    isPending: false,
    error: null,
  }),
}));

describe('MediaDetail episode tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useEpisodes.mockReturnValue({
      data: [
        {
          id: 'episode-1',
          episode_number: 1,
          name: 'Pilot',
          overview: 'The first episode.',
          runtime_minutes: 42,
          air_date: '2020-01-01',
          still_path: null,
        },
        {
          id: 'episode-2',
          episode_number: 2,
          name: 'Second',
          overview: null,
          runtime_minutes: 44,
          air_date: '2020-01-08',
          still_path: null,
        },
      ],
      isLoading: false,
    });
    mocks.useWatchedEpisodes.mockReturnValue({ data: [1] });
    mocks.useShowWatchProgress.mockReturnValue({
      data: [
        {
          season_number: 1,
          episode_count: 2,
          available_episode_count: 2,
          watched_count: 2,
        },
        {
          season_number: 2,
          episode_count: 2,
          available_episode_count: 2,
          watched_count: 1,
        },
      ],
    });
  });

  it('selects seasons and marks only unwatched episodes', async () => {
    const user = userEvent.setup();
    render(<MediaDetail />);

    const seasonOne = screen.getByRole('tab', { name: /Season 1/ });
    expect(seasonOne).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTitle('Watched')).toBeDisabled();

    await user.click(screen.getByRole('tab', { name: /Season 2/ }));
    expect(mocks.useEpisodes).toHaveBeenLastCalledWith('1399', 2);

    await user.click(screen.getByTitle('Mark watched'));
    expect(mocks.markEpisodeWatched).toHaveBeenCalledWith({
      tmdbId: 1399,
      seasonNumber: 2,
      episodeNumber: 2,
    });
  });

  it('offers to mark previous episodes when the selected episode leaves gaps', async () => {
    const user = userEvent.setup();
    mocks.useWatchedEpisodes.mockReturnValue({ data: [] });
    mocks.useShowWatchProgress.mockReturnValue({
      data: [
        {
          season_number: 1,
          episode_count: 2,
          available_episode_count: 2,
          watched_count: 0,
        },
      ],
    });
    render(<MediaDetail />);

    await user.click(screen.getAllByTitle('Mark watched')[1]);
    expect(screen.getByRole('dialog', { name: 'Mark S01E02 watched?' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'This and previous' }));
    expect(mocks.markEpisodesWatchedThrough).toHaveBeenCalledWith(
      {
        tmdbId: 1399,
        seasonNumber: 1,
        episodeNumber: 2,
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(mocks.markEpisodeWatched).not.toHaveBeenCalled();
  });

  it('confirms marking every available episode in a season', async () => {
    const user = userEvent.setup();
    render(<MediaDetail />);

    await user.click(screen.getByRole('button', { name: 'Mark season watched' }));
    expect(screen.getByRole('dialog', { name: 'Mark Season 1 watched?' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Mark season' }));
    expect(mocks.markSeasonWatched).toHaveBeenCalledWith(
      {
        tmdbId: 1399,
        seasonNumber: 1,
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
