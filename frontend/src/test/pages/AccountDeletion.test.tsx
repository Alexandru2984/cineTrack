import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import AccountDeletionPage from '@/pages/AccountDeletion';
import { useAuthStore } from '@/store/auth';

describe('Account deletion page', () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null, status: 'anonymous' });
  });

  it('sends signed-out users through login and back to the danger zone', () => {
    render(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Delete your Văzute account' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Continue to account deletion' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Fsettings%23delete-account',
    );
    expect(screen.getByText(/Disaster-recovery backups expire within 14 days/)).toBeVisible();
  });

  it('links authenticated users directly to account settings', () => {
    useAuthStore.setState({
      token: 'access-token',
      status: 'authenticated',
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        username: 'privacy_user',
        email: 'privacy@example.com',
        avatar_url: null,
        bio: null,
        is_public: false,
        email_verified: true,
        created_at: '2026-07-17T00:00:00Z',
      },
    });

    render(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Continue to account deletion' })).toHaveAttribute(
      'href',
      '/settings#delete-account',
    );
  });
});
