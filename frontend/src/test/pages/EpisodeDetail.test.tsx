import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EpisodeDetailPage from '@/pages/EpisodeDetail';
import type { EpisodeDetail } from '@/types';

const mocks = vi.hoisted(() => ({
  episode: null as EpisodeDetail | null,
  markWatched: vi.fn(),
  setPlanned: vi.fn(),
}));

vi.mock('@/hooks/useMedia', () => ({
  useEpisodeDetail: () => ({
    data: mocks.episode,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCalendar', () => ({
  useMarkCalendarEpisodeWatched: () => ({
    mutate: mocks.markWatched,
    isPending: false,
    error: null,
  }),
  useSetEpisodePlanned: () => ({
    mutate: mocks.setPlanned,
    isPending: false,
    error: null,
  }),
}));

const availableEpisode: EpisodeDetail = {
  episode_id: '35ef8cf6-07b2-47ab-a886-d78209fe4769',
  media_id: '82ef0579-b27f-4d40-a838-124102db0a32',
  tmdb_id: 1399,
  title: 'Test Show',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  season_id: '41c1dc83-0f7b-498a-a439-98a9baa1f7ee',
  season_number: 2,
  season_name: 'Season Two',
  episode_number: 3,
  episode_name: 'The Detail',
  overview: 'A complete synopsis.',
  runtime_minutes: 52,
  air_date: '2026-07-19',
  still_path: '/still.jpg',
  tracking_status: 'watching',
  is_available: true,
  is_watched: false,
  is_planned: false,
  watch_count: 0,
  last_watched_at: null,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/episodes/${availableEpisode.episode_id}`]}>
      <Routes>
        <Route path="/episodes/:id" element={<EpisodeDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EpisodeDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.episode = { ...availableEpisode };
  });

  it('shows episode context and exposes independent episode actions', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByRole('heading', { name: 'The Detail' })).toBeVisible();
    expect(screen.getByText('S02E03')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Test Show' })).toHaveAttribute(
      'href',
      '/media/1399?type=tv',
    );

    await user.click(screen.getByRole('button', { name: 'Watch next' }));
    expect(mocks.setPlanned).toHaveBeenCalledWith({
      episodeId: availableEpisode.episode_id,
      planned: true,
    });

    await user.click(screen.getByRole('button', { name: 'Mark watched' }));
    expect(mocks.markWatched).toHaveBeenCalledWith(availableEpisode.episode_id);
  });

  it('does not offer watched state before the release date', () => {
    mocks.episode = {
      ...availableEpisode,
      air_date: '2026-08-01',
      is_available: false,
      is_planned: true,
    };
    renderPage();

    expect(screen.queryByRole('button', { name: 'Mark watched' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from Watch next' })).toBeEnabled();
    expect(screen.getByText(/after its release date/i)).toBeVisible();
  });
});
