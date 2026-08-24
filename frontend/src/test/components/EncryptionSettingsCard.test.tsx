import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EncryptionSettingsCard } from '@/components/EncryptionSettingsCard';
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
function renderAt(status: Status) {
  act(() => {
    useEncryptionStore.setState({ status });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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
    // Both routes back in, because somebody who has forgotten their password
    // still has the recovery code, and vice versa.
    expect(screen.getByRole('button', { name: /use my password/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use my recovery code/i })).toBeInTheDocument();
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
