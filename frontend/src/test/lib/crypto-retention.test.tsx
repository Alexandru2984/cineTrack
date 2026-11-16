import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetKeysOfEndedSessions,
  keysLeaveWithSession,
  recordKeyRetention,
} from '@/lib/crypto/retention';
import { useLogout } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth';

// VAZ-13. The web stores message keys unwrapped and kept them after sign-out
// unless a second button was pressed, so a borrowed browser handed the next
// person every past message. A sign-in that did not ask to be kept now takes
// its keys with it.
const forgetIdentity = vi.fn(async (userId: string) => userId);
const forgetPins = vi.fn(async (userId: string) => userId);
const endSession = vi.fn(async () => undefined);

vi.mock('@/lib/crypto/storage', () => ({
  forgetIdentity: (userId: string) => forgetIdentity(userId),
  loadIdentity: vi.fn(),
  saveIdentity: vi.fn(),
  storageIsAvailable: vi.fn(async () => true),
}));
vi.mock('@/lib/crypto/pins', () => ({
  forgetPins: (userId: string) => forgetPins(userId),
}));
vi.mock('@/lib/api', () => ({
  default: { post: vi.fn(), get: vi.fn() },
  endSession: () => endSession(),
  isAuthPayload: () => true,
  MalformedAuthResponseError: class extends Error {},
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

async function signOut(userId: string, forgetKeys?: boolean) {
  useAuthStore.setState({
    token: 'token',
    user: { id: userId, username: userId } as never,
    status: 'authenticated',
  });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result } = renderHook(() => useLogout(), { wrapper: wrapper(client) });
  result.current.mutate(forgetKeys === undefined ? {} : { forgetKeys });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

describe('message keys and "keep me signed in"', () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetIdentity.mockClear();
    forgetPins.mockClear();
    endSession.mockClear();
  });

  it('remembers, per account, whether the sign-in was kept', () => {
    recordKeyRetention('shared', false);
    recordKeyRetention('owned', true);

    expect(keysLeaveWithSession('shared')).toBe(true);
    expect(keysLeaveWithSession('owned')).toBe(false);
    expect(keysLeaveWithSession(null)).toBe(false);

    recordKeyRetention('shared', true);
    expect(keysLeaveWithSession('shared')).toBe(false);
  });

  it('signing out of a sign-in that was not kept forgets its keys', async () => {
    recordKeyRetention('borrowed', false);

    await signOut('borrowed');

    expect(endSession).toHaveBeenCalled();
    expect(forgetIdentity).toHaveBeenCalledWith('borrowed');
    expect(forgetPins).toHaveBeenCalledWith('borrowed');
    expect(keysLeaveWithSession('borrowed')).toBe(false);
  });

  it('signing out of a kept sign-in keeps them, unless asked', async () => {
    recordKeyRetention('mine', true);

    await signOut('mine');
    expect(forgetIdentity).not.toHaveBeenCalled();

    await signOut('mine', true);
    expect(forgetIdentity).toHaveBeenCalledWith('mine');
  });

  it('a browser closed without signing out drops the keys on the next visit', async () => {
    recordKeyRetention('closed-tab', false);
    recordKeyRetention('kept', true);

    await forgetKeysOfEndedSessions(null);

    expect(forgetIdentity).toHaveBeenCalledWith('closed-tab');
    expect(forgetIdentity).not.toHaveBeenCalledWith('kept');
    expect(keysLeaveWithSession('closed-tab')).toBe(false);
  });

  it('spares the account that is signed in now', async () => {
    recordKeyRetention('current', false);
    recordKeyRetention('earlier', false);

    await forgetKeysOfEndedSessions('current');

    expect(forgetIdentity).toHaveBeenCalledWith('earlier');
    expect(forgetIdentity).not.toHaveBeenCalledWith('current');
    expect(keysLeaveWithSession('current')).toBe(true);
  });
});
