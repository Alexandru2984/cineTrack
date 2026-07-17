import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TrackingPage from '@/pages/Tracking';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  resetUpdate: vi.fn(),
  remove: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@/hooks/useTracking', () => ({
  useTrackingInfinite: () => ({
    data: {
      pages: [[{
        id: 'tracking-1',
        media_id: 'media-1',
        tmdb_id: 42,
        media_type: 'movie',
        title: 'Test Movie',
        poster_path: null,
        status: 'completed',
        rating: 7,
        review: 'Original review',
        is_favorite: false,
        started_at: null,
        completed_at: null,
      }]],
      pageParams: [1],
    },
    isLoading: false,
    isError: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
    refetch: vi.fn(),
  }),
  useUpdateTracking: () => ({
    mutate: mocks.update,
    reset: mocks.resetUpdate,
    isPending: false,
    error: null,
  }),
  useDeleteTracking: () => ({ mutate: mocks.remove }),
}));

describe('Tracking rating and review editor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates a rating and trims the review', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TrackingPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit rating and review for Test Movie' }));
    expect(screen.getByRole('dialog', { name: 'Your rating and review' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Increase rating' }));
    const review = screen.getByRole('textbox', { name: 'Review' });
    await user.clear(review);
    await user.type(review, '  Better on a second viewing.  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.update).toHaveBeenCalledWith(
      {
        id: 'tracking-1',
        rating: 8,
        review: 'Better on a second viewing.',
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('sends nulls when feedback is cleared', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TrackingPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit rating and review for Test Movie' }));
    await user.click(screen.getByRole('button', { name: 'Clear rating' }));
    await user.clear(screen.getByRole('textbox', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.update).toHaveBeenCalledWith(
      { id: 'tracking-1', rating: null, review: null },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('loads the next library page on demand', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TrackingPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
  });
});
