import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from '@/components/MobileTabBar';
import { useAuthStore } from '@/store/auth';

vi.mock('@/hooks/useCalendar', () => ({
  useCalendarSummary: () => ({
    data: {
      new_count: 4,
      planned_count: 0,
      last_synced_at: null,
    },
  }),
}));

describe('MobileTabBar', () => {
  beforeEach(() => {
    useAuthStore.setState({
      token: 'test-token',
      status: 'authenticated',
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        username: 'mobile_user',
        email: 'mobile@example.com',
        avatar_url: null,
        bio: null,
        is_public: true,
        created_at: '2026-01-01T00:00:00Z',
      },
    });
  });

  it('exposes the five primary destinations and active calendar state', () => {
    render(
      <MemoryRouter initialEntries={['/calendar']}>
        <MobileTabBar />
      </MemoryRouter>,
    );

    const navigation = screen.getByRole('navigation', {
      name: 'Primary mobile navigation',
    });
    expect(within(navigation).getAllByRole('link')).toHaveLength(5);
    expect(within(navigation).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      within(navigation).getByRole('link', { name: 'Calendar, 4 new episodes' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('link', { name: 'Library' })).toHaveAttribute(
      'href',
      '/tracking',
    );
    expect(within(navigation).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/profile/mobile_user',
    );
  });
});
