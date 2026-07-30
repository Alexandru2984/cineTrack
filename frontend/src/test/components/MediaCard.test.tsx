import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaCard } from '@/components/MediaCard';

const mocks = vi.hoisted(() => ({
  createTracking: vi.fn(),
}));

vi.mock('@/hooks/useTracking', () => ({
  useCreateTracking: () => ({
    mutate: mocks.createTracking,
    isPending: false,
    error: null,
  }),
}));

describe('MediaCard quick tracking actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTracking.mockImplementation(
      (
        _input: unknown,
        options?: {
          onSuccess?: () => void;
        },
      ) => options?.onSuccess?.(),
    );
  });

  it('keeps touch actions outside links and saves Plan to Watch', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MediaCard
          item={{
            id: 123,
            media_type: 'movie',
            title: 'Touch Movie',
            poster_path: '/poster.jpg',
          }}
          showQuickAdd
        />
      </MemoryRouter>,
    );

    const planButton = screen.getByRole('button', {
      name: 'Add Touch Movie as Plan to Watch',
    });
    expect(planButton.closest('a')).toBeNull();
    expect(planButton.parentElement?.parentElement).toHaveClass('opacity-100');

    await user.click(planButton);

    expect(mocks.createTracking).toHaveBeenCalledWith(
      {
        tmdb_id: 123,
        media_type: 'movie',
        status: 'plan_to_watch',
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByText('✓ Added as Plan to Watch')).toBeVisible();
  });

  it('shows a previously saved Plan to Watch status after remounting', () => {
    const item = {
      id: 123,
      media_type: 'movie',
      title: 'Persisted Movie',
      poster_path: '/poster.jpg',
    };
    const { unmount } = render(
      <MemoryRouter>
        <MediaCard
          item={item}
          showQuickAdd
          trackingStatus="plan_to_watch"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('✓ Added as Plan to Watch')).toBeVisible();
    expect(
      screen.queryByRole('button', {
        name: 'Add Persisted Movie as Plan to Watch',
      }),
    ).not.toBeInTheDocument();

    unmount();
    render(
      <MemoryRouter>
        <MediaCard
          item={item}
          showQuickAdd
          trackingStatus="plan_to_watch"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('✓ Added as Plan to Watch')).toBeVisible();
  });
});
