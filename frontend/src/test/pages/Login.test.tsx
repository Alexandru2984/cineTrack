import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '@/pages/Login';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/hooks/useAuth', () => ({
  useLogin: () => ({
    // Challenge the first attempt (no code), accept once a code is supplied.
    mutate: (
      vars: { totp_code?: string },
      opts: { onSuccess: () => void; onError: (e: unknown) => void },
    ) => {
      mocks.mutate(vars);
      if (!vars.totp_code) {
        opts.onError({ response: { data: { two_factor_required: true } } });
      } else {
        opts.onSuccess();
      }
    },
    isPending: false,
    error: null,
  }),
}));

describe('LoginPage two-factor step', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reveals the code step on challenge and completes with a code', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Email'), 'mfa@example.com');
    await user.type(screen.getByLabelText('Password'), 'Pass1234');
    // No code field before the challenge.
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The challenge surfaced the code step.
    const codeField = await screen.findByLabelText('Authentication code');
    expect(codeField).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();

    await user.type(codeField, '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(mocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ totp_code: '123456' }),
    );
    expect(mocks.navigate).toHaveBeenCalled();
  });
});
