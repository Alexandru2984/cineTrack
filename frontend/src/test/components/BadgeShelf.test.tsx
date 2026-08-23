import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BadgeShelf } from '@/components/BadgeShelf';
import type { BadgeShelf as Shelf } from '@/types';

const mocks = vi.hoisted(() => ({ shelf: vi.fn() }));

vi.mock('@/hooks/useBadges', () => ({
  useBadges: () => mocks.shelf(),
}));

function show(title: string) {
  return {
    media_id: title,
    tmdb_id: 1,
    title,
    poster_path: null,
    earned_at: '2026-08-01T00:00:00Z',
  };
}

describe('BadgeShelf', () => {
  it('shows one entry per tier, not one per show', () => {
    // The failure this guards against is the old app's: a row per show, two
    // hundred of them, and nothing legible.
    const shelf: Shelf = {
      earned: [
        {
          key: 'marathon-3',
          family: 'marathon24',
          threshold: 3,
          count: 12,
          first_earned_at: '2026-08-01T00:00:00Z',
          shows: [show('One'), show('Two'), show('Three'), show('Four')],
        },
      ],
      progress: [],
    };
    mocks.shelf.mockReturnValue({ data: shelf, isLoading: false, isError: false });

    render(<BadgeShelf />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Earned for 12 shows')).toBeInTheDocument();
  });

  it('names the show when a tier was earned exactly once', () => {
    const shelf: Shelf = {
      earned: [
        {
          key: 'marathon-5',
          family: 'marathon24',
          threshold: 5,
          count: 1,
          first_earned_at: '2026-08-01T00:00:00Z',
          shows: [show('Silicon Valley')],
        },
      ],
      progress: [],
    };
    mocks.shelf.mockReturnValue({ data: shelf, isLoading: false, isError: false });

    render(<BadgeShelf />);
    expect(screen.getByText('Earned for Silicon Valley')).toBeInTheDocument();
  });

  it('renders progress towards the next tier as an accessible bar', () => {
    const shelf: Shelf = {
      earned: [],
      progress: [
        { family: 'marathon24', next_key: 'marathon-5', current: 3, threshold: 5 },
      ],
    };
    mocks.shelf.mockReturnValue({ data: shelf, isLoading: false, isError: false });

    render(<BadgeShelf />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '5');
  });

  it('says the shelf is empty rather than rendering nothing', () => {
    // An empty section with no words reads as a broken page.
    mocks.shelf.mockReturnValue({
      data: { earned: [], progress: [] },
      isLoading: false,
      isError: false,
    });

    render(<BadgeShelf />);
    expect(screen.getByText('No badges yet')).toBeInTheDocument();
  });
});
