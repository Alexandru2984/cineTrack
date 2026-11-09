import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataExportCard } from '@/components/DataExportCard';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

const mocks = vi.hoisted(() => ({
  exportLibrary: vi.fn(),
  exportAccount: vi.fn(),
  resetAccount: vi.fn(),
  accountError: null as unknown,
}));

vi.mock('@/hooks/useTracking', () => ({
  useExportLibrary: () => ({ mutate: mocks.exportLibrary, isPending: false, isError: false }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useExportAccount: () => ({
    mutate: mocks.exportAccount,
    reset: mocks.resetAccount,
    isPending: false,
    error: mocks.accountError,
  }),
}));

function signIn(twoFactor: boolean) {
  useAuthStore.setState({
    user: { id: 'user-1', username: 'micu', two_factor_enabled: twoFactor } as User,
  });
}

describe('DataExportCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountError = null;
  });

  it('downloads the whole library, unfiltered, named in the reader\'s language', async () => {
    signIn(false);
    const user = userEvent.setup();
    render(<DataExportCard />);

    await user.click(screen.getByRole('button', { name: 'Download library (CSV)' }));
    expect(mocks.exportLibrary).toHaveBeenCalledWith({ filters: {}, language: 'en' });
  });

  it('asks for the password before exporting the account', async () => {
    signIn(false);
    const user = userEvent.setup();
    render(<DataExportCard />);

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export account (JSON)' }));
    await user.type(screen.getByLabelText('Current password'), 'hunter22');
    expect(screen.queryByLabelText('Authenticator or recovery code')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(mocks.exportAccount).toHaveBeenCalledWith(
      { password: 'hunter22' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('sends the second factor when the account has one', async () => {
    signIn(true);
    const user = userEvent.setup();
    render(<DataExportCard />);

    await user.click(screen.getByRole('button', { name: 'Export account (JSON)' }));
    await user.type(screen.getByLabelText('Current password'), 'hunter22');
    await user.type(screen.getByLabelText('Authenticator or recovery code'), ' 123456 ');
    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(mocks.exportAccount).toHaveBeenCalledWith(
      { password: 'hunter22', totp_code: '123456' },
      expect.anything(),
    );
  });

  it('closes the form and forgets the password on cancel', async () => {
    signIn(false);
    const user = userEvent.setup();
    render(<DataExportCard />);

    await user.click(screen.getByRole('button', { name: 'Export account (JSON)' }));
    await user.type(screen.getByLabelText('Current password'), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(mocks.resetAccount).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Export account (JSON)' }));
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });
});
