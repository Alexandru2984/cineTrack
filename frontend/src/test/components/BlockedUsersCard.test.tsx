import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BlockedUsersCard } from '@/components/BlockedUsersCard';

const mocks = vi.hoisted(() => ({
  unblock: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@/hooks/useSocial', () => ({
  useBlockedUsers: () => ({
    data: {
      pages: [
        [
          {
            id: '00000000-0000-0000-0000-000000000002',
            username: 'blocked_member',
            avatar_url: null,
            blocked_at: '2026-07-30T00:00:00Z',
          },
        ],
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
    refetch: vi.fn(),
  }),
  useUnblockUser: () => ({
    mutate: mocks.unblock,
    isPending: false,
    error: null,
  }),
}));

describe('BlockedUsersCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists blocked accounts and can unblock one', async () => {
    const user = userEvent.setup();
    render(<BlockedUsersCard />);

    expect(screen.getByText('blocked_member')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(mocks.unblock).toHaveBeenCalledWith('blocked_member');
  });
});
