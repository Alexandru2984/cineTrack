import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EncryptionSettingsCard } from '@/components/EncryptionSettingsCard';
import { encryptionKeys } from '@/hooks/useEncryption';
import { useEncryptionStore } from '@/store/encryption';

/** The regression this exists for.
 *
 *  Encryption used to be offered in exactly one place: above the message
 *  composer, inside a thread with somebody who could already be messaged. Direct
 *  messages require a mutual follow, so reaching it needed a friend, an open
 *  conversation, and a reason to look — and in production not one account of
 *  eleven had ever set it up.
 *
 *  What matters is not how the card looks. It is that every state a member can
 *  be in offers them the thing they need, from a page they can simply open.
 */
afterEach(() => {
  // Unmount before resetting the store. React Testing Library's own cleanup
  // runs after this hook, so a bare setState here reaches components that are
  // still mounted and warns about an update outside act().
  cleanup();
  act(() => {
    useEncryptionStore.setState({ status: 'loading', identity: null, fingerprint: null });
  });
});

type Status = 'loading' | 'ready' | 'locked' | 'absent' | 'unavailable';

// The restore and setup forms are react-query mutations, so they need a client
// even though nothing here submits one.
function renderAt(status: Status, hasPasswordCopy = false) {
  act(() => {
    useEncryptionStore.setState({ status });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Whether the account still carries a copy of its key that the password
  // opens. Seeded rather than fetched: the query is answered from cache, and
  // what these tests are about is which forms that answer produces.
  client.setQueryData(encryptionKeys.backup, hasPasswordCopy);
  return render(
    <QueryClientProvider client={client}>
      <EncryptionSettingsCard />
    </QueryClientProvider>,
  );
}

describe('EncryptionSettingsCard', () => {
  it('offers setup to an account that has never turned encryption on', () => {
    renderAt('absent');

    // The point of the card: the setup form is here, with no conversation
    // needed to reach it.
    expect(screen.getByRole('heading', { name: /turn on end-to-end encryption/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set up encryption/i })).toBeInTheDocument();
  });

  it('offers a restore when the account has keys this device does not hold', () => {
    renderAt('locked');

    expect(screen.getByRole('heading', { name: /restore your encryption key/i })).toBeInTheDocument();
    // The recovery code, and only the recovery code. The password used to open
    // a second copy of the key; it opens nothing now, so offering it would send
    // somebody hunting for a password that was never going to work.
    expect(screen.getByRole('button', { name: /use my recovery code/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use my password/i })).not.toBeInTheDocument();
  });

  it('still offers the password to an account that has not finished the upgrade', () => {
    // Set up before the password copy was removed and never rotated since:
    // that copy is what this person has, and taking the option away would lock
    // them out to close a finding they never heard about.
    renderAt('locked', true);

    expect(screen.getByRole('button', { name: /use my password/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use my recovery code/i })).toBeInTheDocument();
  });

  it('offers a new recovery code once this device holds the key', () => {
    renderAt('ready');

    // Rotating is only possible from a device that can seal the key again, so
    // the form appears exactly here.
    expect(screen.getByRole('button', { name: /generate a new code/i })).toBeInTheDocument();
  });

  it('explains why the upgrade is worth doing while the old copy is still there', () => {
    renderAt('ready', true);

    expect(screen.getByText(/your account password opens/i)).toBeInTheDocument();
  });

  it('says encryption is on rather than going blank', () => {
    renderAt('ready');

    // The gate renders nothing once the key is loaded. A section that vanishes
    // when the feature works tells the reader nothing about whether it does.
    expect(screen.getByText(/this device holds your key/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up encryption/i })).not.toBeInTheDocument();
  });

  it('explains a browser that cannot store keys instead of offering a form', () => {
    renderAt('unavailable');

    expect(screen.getByText(/cannot store encryption keys/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up encryption/i })).not.toBeInTheDocument();
  });

  it('shows the heading in every state, so the section never disappears', () => {
    for (const status of ['loading', 'ready', 'locked', 'absent', 'unavailable'] as const) {
      const { unmount } = renderAt(status);
      expect(
        screen.getByRole('heading', { name: /message encryption/i }),
        `heading missing while status was "${status}"`,
      ).toBeInTheDocument();
      unmount();
    }
  });
});
