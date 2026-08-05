import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionsDialog } from '@/components/ConnectionsDialog';

const mocks = vi.hoisted(() => ({
  onClose: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@/hooks/useSocial', () => ({
  useUserConnections: () => ({
    data: {
      pages: [[{
        id: '00000000-0000-0000-0000-000000000002',
        username: 'movie_friend',
        avatar_url: null,
        bio: 'Thrillers and animation',
      }]],
    },
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
    refetch: vi.fn(),
  }),
}));

describe('ConnectionsDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows profile links and closes from its button', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ConnectionsDialog username="alice" kind="followers" onClose={mocks.onClose} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('dialog', { name: 'Followers of @alice' })).toBeVisible();
    expect(screen.getByRole('link', { name: /movie_friend/i })).toHaveAttribute(
      'href',
      '/profile/movie_friend',
    );

    await user.click(screen.getByRole('button', { name: 'Close connections' }));
    expect(mocks.onClose).toHaveBeenCalledOnce();
  });
});
