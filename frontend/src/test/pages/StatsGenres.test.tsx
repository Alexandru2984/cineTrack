import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import StatsPage from '@/pages/Stats';

const mocks = vi.hoisted(() => ({
  genres: vi.fn(),
}));

vi.mock('@/hooks/useStats', () => ({
  // Every field the summary cards read. A partial fixture let
  // `Math.round(undefined)` reach the DOM as NaN, and a warning that is always
  // there is a warning nobody reads the next time it means something.
  useMyStats: () => ({
    data: {
      total_movies: 0,
      total_shows: 0,
      total_episodes: 0,
      total_hours: 0,
      current_streak: 0,
      longest_streak: 0,
    },
    isLoading: false,
  }),
  useHeatmap: () => ({ data: [] }),
  useMonthlyActivity: () => ({ data: [] }),
  useGenreDistribution: () => mocks.genres(),
}));

// Recharts measures its container, which jsdom reports as zero, so the chart
// itself renders nothing. The legend is plain DOM and is what this test is
// about anyway — it is the part that replaced the overlapping labels.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

function renderStats() {
  return render(
    <MemoryRouter>
      <StatsPage />
    </MemoryRouter>,
  );
}

describe('Stats genre breakdown', () => {
  it('keeps the six largest genres and folds the rest into one entry', () => {
    // A real library spans about thirty genres. Every one of them used to draw
    // its name and percentage around a three-hundred-pixel circle, which is how
    // the chart became a smear of overlapping text.
    mocks.genres.mockReturnValue({
      data: Array.from({ length: 30 }, (_, index) => ({
        genre: `Genre ${index + 1}`,
        count: 100 - index,
      })),
    });

    renderStats();

    expect(screen.getByText('Genre 1')).toBeInTheDocument();
    expect(screen.getByText('Genre 6')).toBeInTheDocument();
    // The seventh largest is inside the bucket, not beside it.
    expect(screen.queryByText('Genre 7')).not.toBeInTheDocument();
    expect(screen.getByText('Other genres')).toBeInTheDocument();
  });

  it('leaves a short list alone rather than bucketing one genre', () => {
    // Folding a single genre into "Other" would replace a name with a word
    // meaning less than the name did.
    mocks.genres.mockReturnValue({
      data: [
        { genre: 'Drama', count: 10 },
        { genre: 'Comedy', count: 5 },
      ],
    });

    renderStats();

    expect(screen.getByText('Drama')).toBeInTheDocument();
    expect(screen.getByText('Comedy')).toBeInTheDocument();
    expect(screen.queryByText('Other genres')).not.toBeInTheDocument();
  });
});
