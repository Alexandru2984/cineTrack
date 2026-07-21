import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpNextEpisodes } from '@/components/UpNextEpisodes';

const mocks = vi.hoisted(() => ({
  useUpNextEpisodes: vi.fn(),
  setPlanned: vi.fn(),
  markWatched: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useCalendar', () => ({
  localDateKey: () => '2026-07-16',
  useUpNextEpisodes: () => mocks.useUpNextEpisodes(),
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

const episode = {
  episode_id: 'episode-one',
  media_id: 'media-one',
  tmdb_id: 101,
  title: 'Sequential Show',
  poster_path: '/poster.jpg',
  season_number: 2,
  episode_number: 4,
  episode_name: 'The Next Step',
  overview: null,
  runtime_minutes: 47,
  air_date: '2026-07-16',
  still_path: '/still.jpg',
  is_planned: true,
  last_watched_at: '2026-07-15T20:00:00.000Z',
};

const dormantEpisode = {
  ...episode,
  episode_id: 'episode-two',
  media_id: 'media-two',
  title: 'Abandoned Show',
  episode_name: 'Where You Stopped',
  is_planned: false,
  last_watched_at: '2023-07-16T20:00:00.000Z',
};

describe('Up Next episodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    mocks.useUpNextEpisodes.mockReturnValue({
      data: { items: [episode] },
      isLoading: false,
      isError: false,
      refetch: mocks.refetch,
    });
  });

  it('renders the sequential episode and exposes direct actions', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><UpNextEpisodes /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Up Next' })).toBeVisible();
    expect(screen.getByText('Sequential Show')).toBeVisible();
    expect(screen.getByText('S02E04')).toBeVisible();
    expect(screen.getByText('Today')).toBeVisible();

    await user.click(
      screen.getByRole('button', {
        name: 'Remove The Next Step from Watch next',
      }),
    );
    expect(mocks.setPlanned).toHaveBeenCalledWith({
      episodeId: 'episode-one',
      planned: false,
    });

    await user.click(
      screen.getByRole('button', {
        name: 'Mark The Next Step watched',
      }),
    );
    expect(mocks.markWatched).toHaveBeenCalledWith('episode-one');
  });

  it('keeps a single list unlabelled when every show is equally current', () => {
    render(<MemoryRouter><UpNextEpisodes /></MemoryRouter>);

    expect(screen.queryByRole('heading', { name: 'Continue watching' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Pick back up' })).toBeNull();
  });

  it('separates a long-abandoned show and says how long it has been', () => {
    mocks.useUpNextEpisodes.mockReturnValue({
      data: { items: [episode, dormantEpisode] },
      isLoading: false,
      isError: false,
      refetch: mocks.refetch,
    });

    render(<MemoryRouter><UpNextEpisodes /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Continue watching' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Pick back up' })).toBeVisible();
    expect(screen.getByText('Watched 3 years ago')).toBeVisible();
    // The current show carries no such note; only the dormant group explains itself.
    expect(screen.queryByText('Watched a day ago')).toBeNull();
  });

  it('offers recovery when the preview request fails', async () => {
    const user = userEvent.setup();
    mocks.useUpNextEpisodes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetch,
    });

    render(<MemoryRouter><UpNextEpisodes /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Retry Up Next' }));

    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
