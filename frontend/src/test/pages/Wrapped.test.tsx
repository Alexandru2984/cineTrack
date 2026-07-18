import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WrappedPage from '@/pages/Wrapped';
import type { WrappedStats } from '@/types';

const mocks = vi.hoisted(() => ({
  result: {} as { data?: WrappedStats; isLoading: boolean; isError: boolean },
}));

vi.mock('@/hooks/useStats', () => ({
  useWrapped: () => mocks.result,
}));

const FULL: WrappedStats = {
  year: 2026,
  total_watches: 42,
  movies_watched: 12,
  episodes_watched: 30,
  distinct_titles: 18,
  total_hours: 61.5,
  longest_streak: 7,
  first_watch: '2026-01-03',
  last_watch: '2026-07-18',
  top_genres: [
    { genre: 'Drama', count: 9 },
    { genre: 'Comedy', count: 4 },
  ],
  top_shows: [
    { tmdb_id: 1399, media_type: 'tv', title: 'Game of Thrones', poster_path: '/got.jpg', count: 20 },
  ],
  monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: i === 5 ? 10 : 1 })),
};

describe('WrappedPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the recap headline stats and top title', () => {
    mocks.result = { data: FULL, isLoading: false, isError: false };
    render(
      <MemoryRouter>
        <WrappedPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '2026' })).toBeInTheDocument();
    expect(screen.getByText('Titles watched')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument(); // distinct titles
    expect(screen.getByText('Most watched')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Game of Thrones/ })).toHaveAttribute(
      'href',
      '/media/1399?type=tv',
    );
    expect(screen.getByText('Drama')).toBeInTheDocument();
  });

  it('shows an empty state when there is no history for the year', () => {
    mocks.result = {
      data: { ...FULL, total_watches: 0, top_shows: [], top_genres: [] },
      isLoading: false,
      isError: false,
    };
    render(
      <MemoryRouter>
        <WrappedPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No watch history/i)).toBeInTheDocument();
  });
});
