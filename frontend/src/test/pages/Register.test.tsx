import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RegisterPage from '@/pages/Register';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/hooks/useAuth', () => ({
  useRegister: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
  }),
}));

describe('RegisterPage terms acceptance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires both statements and sends them explicitly with registration', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>,
    );

    const submit = screen.getByRole('button', { name: 'Create account' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Username'), 'viewer_one');
    await user.type(screen.getByLabelText('Email'), 'viewer@example.com');
    await user.type(screen.getByLabelText('Password'), 'Pass1234');

    const [terms, age] = screen.getAllByRole('checkbox');

    // Each statement is its own gate: accepting the Terms says nothing about
    // age, and the age attestation is what Play Console and GDPR Art. 8 need.
    await user.click(terms);
    expect(submit).toBeDisabled();
    await user.click(age);
    expect(submit).toBeEnabled();

    expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(screen.getByRole('link', { name: 'Community Guidelines' })).toHaveAttribute(
      'href',
      '/community-guidelines',
    );

    await user.click(submit);

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        username: 'viewer_one',
        email: 'viewer@example.com',
        password: 'Pass1234',
        accepted_terms: true,
        confirmed_minimum_age: true,
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
