import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import ProfilePage from '@/pages/Profile';

vi.mock('@/hooks/useSocial', () => ({
  useUserProfile: () => ({
    data: {
      id: '00000000-0000-0000-0000-000000000001',
      username: 'alice',
      avatar_url: null,
      bio: null,
      is_public: true,
      followers_count: 2,
      following_count: 3,
      is_following: false,
      follow_status: null,
      can_view_activity: true,
      created_at: '2026-08-05T00:00:00Z',
    },
    isLoading: false,
  }),
  useUserActivity: () => ({ data: [], isLoading: false, isError: false }),
  useFollow: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUnfollow: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useBlockUser: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: '00000000-0000-0000-0000-000000000001' } }),
}));

vi.mock('@/components/ConnectionsDialog', () => ({
  ConnectionsDialog: ({ kind }: { kind: string }) => <div role="dialog">{kind}</div>,
}));

describe('ProfilePage connections', () => {
  it('opens followers and following from their profile counts', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/profile/alice']}>
        <Routes>
          <Route path="/profile/:username" element={<ProfilePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '2 followers' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('followers');

    await user.click(screen.getByRole('button', { name: '3 following' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('following');
  });
});
