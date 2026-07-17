import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';
import { useAuthStore } from '@/store/auth';

const mocks = vi.hoisted(() => ({ resend: vi.fn() }));

vi.mock('@/hooks/useAuth', () => ({
  useResendVerification: () => ({
    mutate: mocks.resend,
    isPending: false,
    isSuccess: false,
  }),
}));

function setUser(emailVerified: boolean) {
  useAuthStore.setState({
    token: 'test-token',
    status: 'authenticated',
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      username: 'banner_user',
      email: 'banner@example.com',
      avatar_url: null,
      bio: null,
      is_public: true,
      email_verified: emailVerified,
      created_at: '2026-01-01T00:00:00Z',
    },
  });
}

describe('EmailVerificationBanner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts unverified users and resends the link on request', async () => {
    setUser(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <EmailVerificationBanner />
      </MemoryRouter>,
    );

    expect(screen.getByText(/confirm your email/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resend link' }));
    expect(mocks.resend).toHaveBeenCalledTimes(1);
  });

  it('renders nothing once the email is verified', () => {
    setUser(true);
    const { container } = render(
      <MemoryRouter>
        <EmailVerificationBanner />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('can be dismissed for the session', async () => {
    setUser(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <EmailVerificationBanner />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/confirm your email/i)).not.toBeInTheDocument();
  });
});
