import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PrivacyPage from '@/pages/Privacy';

describe('Privacy page', () => {
  it('publishes the controller, retention, and deletion route', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
    expect(screen.getByText('postmaster@micutu.com')).toHaveAttribute(
      'href',
      'mailto:postmaster@micutu.com',
    );
    expect(screen.getByText(/retained for at most 14 days/)).toBeVisible();
    expect(screen.getByText(/Mobile diagnostics:/)).toBeVisible();
    expect(screen.getByText(/Release alerts, when enabled:/)).toBeVisible();
    expect(screen.getByText(/Expo relays the push token/)).toBeVisible();
    expect(screen.getByText(/delivery records are removed after 30 days/)).toBeVisible();
    expect(screen.getByText(/size-limited rotating server logs/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'account deletion page' })).toHaveAttribute(
      'href',
      '/account-deletion',
    );
  });
});
