import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TermsAcceptanceGate } from '@/components/TermsAcceptanceGate';
import { useAuthStore } from '@/store/auth';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAcceptTerms: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
  }),
}));

function setTermsRequired(required: boolean) {
  useAuthStore.setState({
    token: 'test-token',
    status: 'authenticated',
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      username: 'legacy_user',
      email: 'legacy@example.com',
      avatar_url: null,
      bio: null,
      is_public: false,
      email_verified: true,
      two_factor_enabled: false,
      terms_accepted_version: required ? null : '2026-08-05',
      terms_accepted_at: required ? null : '2026-08-05T00:00:00Z',
      current_terms_version: '2026-08-05',
      terms_acceptance_required: required,
      created_at: '2026-01-01T00:00:00Z',
    },
  });
}

describe('TermsAcceptanceGate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks an outdated account until explicit acceptance', async () => {
    setTermsRequired(true);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TermsAcceptanceGate />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('dialog', { name: 'Review the current community terms' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(screen.getByRole('link', { name: 'Community Guidelines' })).toHaveAttribute(
      'href',
      '/community-guidelines',
    );

    await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('does not render after the current version is accepted', () => {
    setTermsRequired(false);
    const { container } = render(
      <MemoryRouter>
        <TermsAcceptanceGate />
      </MemoryRouter>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
