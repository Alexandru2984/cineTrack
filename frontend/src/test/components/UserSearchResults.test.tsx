import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserSearchResults } from '@/components/UserSearchResults';
import type { UserSearchResponse } from '@/types';

const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  unfollow: vi.fn(),
}));

vi.mock('@/hooks/useSocial', () => ({
  useFollow: () => ({
    mutate: mocks.follow,
    isPending: false,
    variables: undefined,
    error: null,
  }),
  useUnfollow: () => ({
    mutate: mocks.unfollow,
    isPending: false,
    variables: undefined,
    error: null,
  }),
}));

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'self-id' } }),
}));

const data: UserSearchResponse = {
  page: 1,
  has_more: true,
  results: [
    {
      id: 'self-id',
      username: 'current_user',
      avatar_url: null,
      bio: 'Own profile',
      is_public: true,
      followers_count: 2,
      follow_status: null,
    },
    {
      id: 'public-id',
      username: 'public_user',
      avatar_url: null,
      bio: 'Public profile',
      is_public: true,
      followers_count: 1,
      follow_status: null,
    },
    {
      id: 'private-id',
      username: 'private_user',
      avatar_url: null,
      bio: null,
      is_public: false,
      followers_count: 0,
      follow_status: 'pending',
    },
  ],
};

describe('UserSearchResults', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders privacy and relationship states and runs their actions', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UserSearchResults
          data={data}
          isLoading={false}
          isError={false}
          page={1}
          onPageChange={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'public_user' })).toHaveAttribute(
      'href',
      '/profile/public_user',
    );

    await user.click(screen.getByRole('button', { name: 'Follow public_user' }));
    expect(mocks.follow).toHaveBeenCalledWith('public_user');

    await user.click(screen.getByRole('button', { name: 'Cancel request private_user' }));
    expect(mocks.unfollow).toHaveBeenCalledWith('private_user');
  });

  it('paginates using the server has_more signal', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <MemoryRouter>
        <UserSearchResults
          data={data}
          isLoading={false}
          isError={false}
          page={1}
          onPageChange={onPageChange}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
